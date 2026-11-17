/**
 * 최초 1회 모델 자동 다운로드.
 *
 * 이 저장소의 GitHub Release(model-v1)에 올라간 조각들을 받아 기기 안에서 이어 붙인다.
 * Release 는 .github/workflows/publish-model.yml 이 Hugging Face git 저장소에서 받아 만든다.
 *
 *   manifest.json            조각 목록 (이름/크기/SHA-256) + 전체 SHA-256
 *   <model>.gguf.part00 …    2 GiB 미만 조각 (GitHub Release 첨부 한도)
 *
 * - 조각 하나를 받을 때마다 SHA-256 을 검사하고 즉시 이어 붙인 뒤 지운다.
 *   → 최대 사용 공간 ≈ 모델 크기 + 조각 1개
 * - 앱이 꺼지거나 네트워크가 끊겨도 다음 실행 때 "완료된 조각 다음"부터 이어서 받는다.
 * - 모델 설치가 끝나면 앱은 더 이상 네트워크를 쓰지 않는다.
 */
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import {
  ensureDir,
  formatBytes,
  isGguf,
  modelsDir,
  readMagic,
  toNativePath,
  type InstalledModel,
  type OnProgress,
} from './modelStore';

export const MODEL_RELEASE_URL = 'https://github.com/JordonPark/gemma-chat/releases/download/model-v1';

const CHUNK = 8 * 1024 * 1024;

export type ManifestPart = { name: string; size: number; sha256: string };
export type Manifest = { format: number; name: string; size: number; sha256: string; parts: ManifestPart[] };

type DownloadState = { sha256: string; done: number };

const dlDir = () => new Directory(Paths.document, '.download');
const stateFile = () => new File(dlDir(), 'state.json');

export class DownloadCancelled extends Error {
  constructor() {
    super('다운로드를 취소했습니다.');
  }
}

function readState(): DownloadState | null {
  try {
    const f = stateFile();
    return f.exists ? (JSON.parse(f.textSync()) as DownloadState) : null;
  } catch {
    return null;
  }
}

function writeState(s: DownloadState) {
  const f = stateFile();
  if (!f.exists) f.create();
  f.writeSync(JSON.stringify(s));
}

/** 이전에 받다 만 다운로드가 있는지 (자동 이어받기 판단용) */
export function hasPartialDownload(): boolean {
  const s = readState();
  return !!s && s.done > 0;
}

/** 바깥 signal 이 취소되면 같이 취소되는 하위 AbortController */
function childController(parent?: AbortSignal) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (parent?.aborted) ac.abort();
  parent?.addEventListener('abort', onAbort);
  return { ac, dispose: () => parent?.removeEventListener('abort', onAbort) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchManifest(signal?: AbortSignal): Promise<Manifest> {
  const { ac, dispose } = childController(signal);
  const timer = setTimeout(() => ac.abort(), 30_000); // 응답 없으면 30초 후 포기
  let res: Response;
  try {
    res = await fetch(`${MODEL_RELEASE_URL}/manifest.json`, { signal: ac.signal, cache: 'no-store' });
  } catch (e: any) {
    if (signal?.aborted) throw new DownloadCancelled();
    throw new Error(
      ac.signal.aborted
        ? '서버가 30초 동안 응답하지 않습니다. 인터넷 연결을 확인하고 다시 시도하세요.'
        : `서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.\n(${e?.message ?? e})`,
    );
  } finally {
    clearTimeout(timer);
    dispose();
  }
  if (res.status === 404) {
    throw new Error(
      '아직 모델이 GitHub Release 에 올라가 있지 않습니다.\n저장소의 Actions › "Publish model" 워크플로우를 먼저 실행해야 합니다.',
    );
  }
  if (!res.ok) throw new Error(`모델 목록을 받지 못했습니다 (HTTP ${res.status}).`);
  const m = (await res.json()) as Manifest;
  if (!m?.parts?.length || !m.name?.endsWith('.gguf')) throw new Error('manifest.json 형식이 올바르지 않습니다.');
  return m;
}

const STALL_MS = 60_000; // 이 시간 동안 1바이트도 안 오면 멈춘 것으로 보고 다시 시도
export const MAX_ATTEMPTS = 3;

/**
 * 조각 하나를 받는다.
 * iOS 는 일반(foreground) 세션을 쓴다. 기본값인 background 세션은 iOS 시스템이 일정을 조절해
 * 시작이 늦거나 매우 느릴 수 있고, 앱을 다시 열었을 때 이전 작업이 남아 새 작업이 멈추기도 한다.
 */
export async function downloadPart(url: string, dest: File, onBytes: (n: number) => void, signal: AbortSignal) {
  const { ac, dispose } = childController(signal);
  let last = Date.now();
  let stalled = false;
  const watchdog = setInterval(() => {
    if (Date.now() - last > STALL_MS) {
      stalled = true;
      ac.abort();
    }
  }, 5_000);
  try {
    const task = File.createDownloadTask(url, dest, {
      sessionType: 'foreground',
      signal: ac.signal,
      onProgress: ({ bytesWritten }) => {
        last = Date.now();
        onBytes(bytesWritten);
      },
    });
    let got: File | null = null;
    try {
      got = await task.downloadAsync();
    } catch (e) {
      if (signal.aborted) throw new DownloadCancelled();
      if (stalled) throw new Error('1분 넘게 데이터가 오지 않습니다');
      throw e;
    }
    if (signal.aborted) throw new DownloadCancelled();
    if (stalled) throw new Error('1분 넘게 데이터가 오지 않습니다');
    if (!got) throw new Error('다운로드가 중단되었습니다');
  } finally {
    clearInterval(watchdog);
    dispose();
  }
}

async function appendFile(src: File, dest: File, onBytes: (n: number) => void) {
  if (!dest.exists) dest.create({ intermediates: true });
  const out = dest.open(FileMode.Append);
  const inp = src.open(FileMode.ReadOnly);
  try {
    for (;;) {
      const bytes = await inp.readBytes(CHUNK);
      if (bytes.length === 0) break;
      await out.writeBytes(bytes);
      onBytes(bytes.length);
    }
  } finally {
    inp.close();
    out.close();
  }
}

/**
 * 모델을 내려받아 설치한다. 이어받기를 지원한다.
 */
export async function downloadModel(onProgress: OnProgress, signal: AbortSignal): Promise<InstalledModel> {
  onProgress({ stage: 'checking', ratio: 0, detail: '모델 목록 확인 중' });
  const m = await fetchManifest(signal);

  const dir = dlDir();
  ensureDir(dir);
  const joined = new File(dir, `${m.name}.joining`);

  // 이어받기 상태 확인: 같은 모델이고, 이어 붙인 파일 크기가 완료된 조각들의 합과 같아야 한다
  let done = 0;
  const st = readState();
  if (st && st.sha256 === m.sha256 && joined.exists) {
    const expected = m.parts.slice(0, st.done).reduce((s, p) => s + p.size, 0);
    if (joined.size === expected) done = st.done;
  }
  if (done === 0) {
    for (const e of dir.list()) e.delete();
    writeState({ sha256: m.sha256, done: 0 });
  }

  // 저장 공간: 남은 이어 붙일 양 + 가장 큰 조각 1개
  const remaining = m.size - (joined.exists ? joined.size ?? 0 : 0);
  const biggest = Math.max(...m.parts.map((p) => p.size));
  const need = remaining + biggest + 200 * 1024 * 1024;
  const free = Paths.availableDiskSpace;
  if (free > 0 && free < need) {
    throw new Error(`저장 공간 부족: 약 ${formatBytes(need)} 필요, 남은 공간 ${formatBytes(free)}`);
  }

  let base = m.parts.slice(0, done).reduce((s, p) => s + p.size, 0);
  if (done > 0) {
    onProgress({
      stage: 'downloading',
      ratio: base / m.size,
      detail: `이어받기: 조각 ${done + 1}/${m.parts.length}부터 (${formatBytes(base)} 완료)`,
    });
  }
  // 속도는 "최근 5초 동안 실제로 내려받은 양"으로 계산한다.
  // (전체 평균으로 계산하면 조각 검사·이어 붙이기 시간까지 포함돼 2번째 조각부터 속도가 낮게 보인다)
  let samples: { t: number; bytes: number }[] = [];
  let speed = 0;
  let lastEmit = 0;
  const resetSpeed = () => {
    samples = [];
    speed = 0;
  };
  const report = (bytesNow: number, label: string, stage: 'downloading' | 'joining' | 'verifying') => {
    const now = Date.now();
    if (stage === 'downloading') {
      samples.push({ t: now, bytes: bytesNow });
      while (samples.length > 2 && now - samples[0].t > 5000) samples.shift();
      const first = samples[0];
      if (now - first.t >= 1000) speed = (bytesNow - first.bytes) / ((now - first.t) / 1000);
      // 진행률 이벤트가 매우 잦으므로 화면 갱신은 0.25초에 한 번만
      if (now - lastEmit < 250) return;
    }
    lastEmit = now;
    const left = speed > 0 ? Math.round((m.size - bytesNow) / speed) : 0;
    onProgress({
      stage,
      ratio: bytesNow / m.size,
      detail:
        `${label} · ${formatBytes(bytesNow)} / ${formatBytes(m.size)}` +
        (stage === 'downloading' && speed > 0
          ? ` · ${formatBytes(speed)}/s · 약 ${left >= 60 ? `${Math.round(left / 60)}분` : `${left}초`} 남음`
          : ''),
    });
  };

  for (let i = done; i < m.parts.length; i++) {
    if (signal.aborted) throw new DownloadCancelled();
    const p = m.parts[i];
    const label = `조각 ${i + 1}/${m.parts.length}`;
    // 이전 실행에서 남은 조각 파일 정리 (이어 붙인 파일·상태 파일만 남긴다)
    for (const e of dir.list()) {
      if (e.uri !== joined.uri && e.uri !== stateFile().uri) e.delete();
    }

    const url = `${MODEL_RELEASE_URL}/${encodeURIComponent(p.name)}`;
    let partFile = new File(dir, p.name);
    for (let attempt = 1; ; attempt++) {
      resetSpeed();
      lastEmit = 0;
      onProgress({
        stage: 'downloading',
        ratio: base / m.size,
        detail: `${label} 연결 중…${attempt > 1 ? ` (재시도 ${attempt - 1}/${MAX_ATTEMPTS - 1})` : ''}`,
      });
      // 매 시도마다 새 이름: 이전 버전 앱이 남긴 iOS 백그라운드 다운로드가 늦게 끝나더라도 겹치지 않게
      partFile = new File(dir, `${p.name}.${Date.now().toString(36)}`);
      try {
        await downloadPart(url, partFile, (n) => report(base + n, label, 'downloading'), signal);
        break;
      } catch (e: any) {
        try {
          if (partFile.exists) partFile.delete(); // 실패한 시도의 조각은 바로 지워 공간 확보
        } catch {}
        if (e instanceof DownloadCancelled || signal.aborted) throw new DownloadCancelled();
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(
            `${label} 다운로드 실패 (${MAX_ATTEMPTS}번 시도): ${e?.message ?? e}\n` +
              'Wi-Fi 연결을 확인하고 다시 시도하세요. 이미 받은 조각은 유지됩니다.',
          );
        }
        await sleep(3_000 * attempt);
      }
    }

    report(base + p.size, `${label} 검사 중`, 'verifying');
    if (partFile.size !== p.size) {
      partFile.delete();
      throw new Error(`${label} 크기가 다릅니다 (기대 ${p.size}, 실제 ${partFile.size}). 다시 시도하세요.`);
    }
    const hash = (await partFile.digest('SHA-256')).toLowerCase();
    if (hash !== p.sha256.toLowerCase()) {
      partFile.delete();
      throw new Error(`${label} SHA-256 불일치. 받는 중 손상되었습니다. 다시 시도하세요.`);
    }

    let appended = 0;
    await appendFile(partFile, joined, (n) => {
      appended += n;
      report(base + appended, `${label} 이어 붙이는 중`, 'joining');
    });
    partFile.delete();
    base += p.size;
    writeState({ sha256: m.sha256, done: i + 1 });
  }

  if (joined.size !== m.size || !isGguf(await readMagic(joined))) {
    for (const e of dir.list()) e.delete();
    throw new Error('완성된 파일이 올바른 GGUF 모델이 아닙니다. 다시 시도하세요.');
  }

  // 설치 (기존 모델 교체)
  const models = modelsDir();
  ensureDir(models);
  for (const e of models.list()) e.delete();
  const dest = new File(models, m.name);
  await joined.move(dest);
  dir.delete();

  onProgress({ stage: 'done', ratio: 1 });
  const installed = new File(models, m.name);
  return { file: installed, path: toNativePath(installed.uri), name: installed.name, size: installed.size ?? 0 };
}

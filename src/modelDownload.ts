/**
 * 최초 1회 모델 자동 다운로드.
 *
 * 이 저장소의 GitHub Release(model-v1)에 올라간 조각들을 받아 기기 안에서 이어 붙인다.
 * Release 는 .github/workflows/publish-model.yml 이 Hugging Face git 저장소에서 받아 만든다.
 *
 *   manifest.json            조각 목록 (이름/크기/SHA-256) + 전체 SHA-256
 *   <model>.gguf.part00 …    2 GiB 미만 조각 (GitHub Release 첨부 한도)
 *
 * - 32MB 씩 HTTP Range 로 받아 한 파일에 바로 이어 붙인다 (src/rangedDownload.ts). 끝나면 전체 SHA-256 검사.
 * - 앱이 꺼지거나 네트워크가 끊겨도 다음 실행 때 받은 곳부터 이어서 받는다.
 * - 모델 설치가 끝나면 앱은 더 이상 네트워크를 쓰지 않는다.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { RangedCancelled, downloadRanged } from './rangedDownload';
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

/** 최근 전송량으로 초당 바이트를 구한다. 재시도나 전송량 감소 시 샘플을 다시 모은다. */
function measureSpeed() {
  let samples: { t: number; bytes: number }[] = [];
  return (done: number, reset = false) => {
    const now = Date.now();
    if (reset || done < (samples.at(-1)?.bytes ?? 0)) samples = [];
    samples.push({ t: now, bytes: done });
    while (samples.length > 2 && now - samples[0].t > 5000) samples.shift();
    const first = samples[0];
    const secs = (now - first.t) / 1000;
    return secs >= 1.5 && done > first.bytes ? (done - first.bytes) / secs : 0;
  };
}

export function formatDownloadEta(seconds: number) {
  return seconds >= 60 ? `약 ${Math.round(seconds / 60)}분 남음` : `약 ${seconds}초 남음`;
}

export function speedMeter(total?: number) {
  const measure = measureSpeed();
  return (done: number, totalBytes = total) => {
    const speed = measure(done);
    if (!speed) return '';
    let out = ` · ${formatBytes(speed)}/s`;
    if (totalBytes) {
      out += ` · ${formatDownloadEta(Math.max(0, Math.round((totalBytes - done) / speed)))}`;
    }
    return out;
  };
}

/**
 * 모델을 내려받아 설치한다.
 * 조각(part00, part01 …)을 32MB 씩 HTTP Range 로 받아 하나의 파일에 바로 이어 붙이고, 끝나면 전체 SHA-256 을 검사한다.
 * 끊겨도 이미 받은 바이트부터 이어 받는다.
 */
export async function downloadModel(onProgress: OnProgress, signal: AbortSignal): Promise<InstalledModel> {
  onProgress({ stage: 'checking', ratio: 0, detail: '모델 목록 확인 중' });
  const m = await fetchManifest(signal);

  const dir = dlDir();
  ensureDir(dir);
  const joined = new File(dir, `${m.name}.joining`);

  // 같은 모델을 받다 만 것이면 이어 받고, 아니면 처음부터
  const st = readState();
  if (!(st && st.sha256 === m.sha256 && joined.exists)) {
    for (const e of dir.list()) e.delete();
  }
  for (const e of dir.list()) if (e.uri !== joined.uri && e.uri !== stateFile().uri) e.delete();
  writeState({ sha256: m.sha256, done: joined.exists ? 1 : 0 });

  const have = joined.exists ? joined.size ?? 0 : 0;
  const need = m.size - have + 200 * 1024 * 1024;
  const free = Paths.availableDiskSpace;
  if (free > 0 && free < need) {
    throw new Error(`저장 공간 부족: 약 ${formatBytes(need)} 필요, 남은 공간 ${formatBytes(free)}`);
  }

  const measure = measureSpeed();
  let lastEmit = 0;
  try {
    await downloadRanged(
      m.parts.map((p) => ({ url: `${MODEL_RELEASE_URL}/${encodeURIComponent(p.name)}`, size: p.size })),
      joined,
      new File(dir, '.chunk'),
      (done, total, note) => {
        const now = Date.now();
        const speed = measure(done, !!note);
        if (!note && now - lastEmit < 250 && done < total) return;
        lastEmit = now;
        onProgress({
          stage: 'downloading',
          ratio: total ? done / total : 0,
          detail: note,
          transfer: {
            received: done,
            total,
            secondsLeft: speed && done < total ? Math.ceil((total - done) / speed) : undefined,
          },
        });
        if (done > 0) writeState({ sha256: m.sha256, done: 1 });
      },
      signal,
    );
  } catch (e: any) {
    if (e instanceof RangedCancelled || signal.aborted) throw new DownloadCancelled();
    throw new Error(`모델 다운로드 실패: ${e?.message ?? e}\nWi-Fi 연결을 확인하고 다시 시도하세요. 받은 곳부터 이어 받습니다.`);
  }

  onProgress({ stage: 'verifying', ratio: 1, detail: '다운로드를 마쳤어요. 모델 파일을 확인하고 있습니다.' });
  const hash = (await joined.digest('SHA-256')).toLowerCase();
  if (joined.size !== m.size || hash !== m.sha256.toLowerCase() || !isGguf(await readMagic(joined))) {
    for (const e of dir.list()) e.delete();
    throw new Error('받은 모델 파일이 손상되었습니다. 다시 시도하면 처음부터 받습니다.');
  }

  // 설치 (기존 모델 교체)
  const models = modelsDir();
  ensureDir(models);
  for (const e of models.list()) e.delete();
  await joined.move(new File(models, m.name));
  dir.delete();

  onProgress({ stage: 'done', ratio: 1 });
  const installed = new File(models, m.name);
  return { file: installed, path: toNativePath(installed.uri), name: installed.name, size: installed.size ?? 0 };
}

export type ModelUpgrade = { name: string; size: number; saving: number };

/**
 * Release 의 모델이 지금 설치된 것과 다르고 더 작으면 그 정보를 돌려준다 (예: 임베딩을 줄인 작은 모델).
 * 확인에 실패하면 null (오프라인이면 조용히 넘어간다).
 */
export async function checkSmallerModel(installed: { name: string; size: number }): Promise<ModelUpgrade | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const m = await fetchManifest(ac.signal);
    if (m.name === installed.name || m.size >= installed.size) return null;
    return { name: m.name, size: m.size, saving: installed.size - m.size };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

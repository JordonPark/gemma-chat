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

export async function fetchManifest(signal?: AbortSignal): Promise<Manifest> {
  let res: Response;
  try {
    res = await fetch(`${MODEL_RELEASE_URL}/manifest.json`, { signal, cache: 'no-store' });
  } catch (e: any) {
    if (signal?.aborted) throw new DownloadCancelled();
    throw new Error(`서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.\n(${e?.message ?? e})`);
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
  const t0 = Date.now();
  const baseAtStart = base;
  const report = (bytesNow: number, label: string, stage: 'downloading' | 'joining' | 'verifying') => {
    const secs = (Date.now() - t0) / 1000;
    const speed = secs > 1 ? (bytesNow - baseAtStart) / secs : 0;
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
    const partFile = new File(dir, p.name);
    if (partFile.exists) partFile.delete();

    const task = File.createDownloadTask(`${MODEL_RELEASE_URL}/${encodeURIComponent(p.name)}`, partFile, {
      onProgress: ({ bytesWritten }) => report(base + bytesWritten, label, 'downloading'),
      signal,
    });
    let got: File | null = null;
    try {
      got = await task.downloadAsync();
    } catch (e: any) {
      if (signal.aborted) throw new DownloadCancelled();
      throw new Error(`${label} 다운로드 실패: ${e?.message ?? e}\n다시 시도하면 이 조각부터 이어서 받습니다.`);
    }
    if (!got || signal.aborted) throw new DownloadCancelled();

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

/**
 * 모델 파일 관리.
 *
 * 자동 다운로드(최초 1회)는 src/modelDownload.ts 가 담당하고,
 * 여기서는 PC에서 옮겨 온 파일을 기기 안에서 "푸는" 수동 설치를 처리한다:
 *
 *   1) 분할 조각(.part00, .part01 … / .001, .002 …)  → 이름순으로 이어 붙임
 *   2) .zip (분할된 zip 조각을 이어 붙인 결과 포함)     → 압축 해제
 *   3) .gguf 단일 파일                                 → 그대로 복사
 *   4) SHA256SUMS / *.sha256 파일을 같이 고르면        → 무결성 검사
 *
 * 최종 결과는 앱 전용 저장소 `Documents/models/<이름>.gguf` 에 놓인다.
 */
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { subscribe as subscribeZip, unzip } from 'react-native-zip-archive';

export const DEFAULT_MODEL_NAME = 'gemma-3-4b-it-q4_0.gguf';

const CHUNK = 8 * 1024 * 1024; // 8 MiB 단위 스트리밍 복사
const GGUF_MAGIC = [0x47, 0x47, 0x55, 0x46]; // "GGUF"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

export const modelsDir = () => new Directory(Paths.document, 'models');
const workDir = () => new Directory(Paths.document, '.import-work');

export type ImportStage =
  | 'checking'
  | 'downloading'
  | 'joining'
  | 'copying'
  | 'unzipping'
  | 'verifying'
  | 'done';
export type ImportProgress = { stage: ImportStage; ratio: number; detail?: string };
export type OnProgress = (p: ImportProgress) => void;

export type InstalledModel = { file: File; path: string; name: string; size: number };

/** llama.cpp 는 file:// 없는 실제 경로가 필요하다 */
export const toNativePath = (uri: string) =>
  decodeURIComponent(uri.startsWith('file://') ? uri.slice('file://'.length) : uri);

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 2 : 0)} ${u[i]}`;
}

export function ensureDir(d: Directory) {
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
}

export async function readMagic(f: File): Promise<number[]> {
  const h = f.open(FileMode.ReadOnly);
  try {
    return Array.from(await h.readBytes(4));
  } finally {
    h.close();
  }
}

export const isGguf = (magic: number[]) => startsWith(magic, GGUF_MAGIC);

const startsWith = (a: number[], b: number[]) => b.every((v, i) => a[i] === v);

/** 설치된 모델 찾기 (Documents/models/*.gguf, 헤더 검증) */
export async function findInstalledModel(): Promise<InstalledModel | null> {
  const dir = modelsDir();
  if (!dir.exists) return null;
  const ggufs = dir
    .list()
    .filter((e): e is File => e instanceof File && e.name.toLowerCase().endsWith('.gguf'))
    .filter((f) => !/mmproj/i.test(f.name)) // 비전 프로젝터는 채팅 모델이 아님
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  for (const f of ggufs) {
    try {
      if (startsWith(await readMagic(f), GGUF_MAGIC)) {
        return { file: f, path: toNativePath(f.uri), name: f.name, size: f.size ?? 0 };
      }
    } catch {
      // 읽을 수 없는 파일은 건너뜀
    }
  }
  return null;
}

export async function deleteInstalledModels() {
  const dir = modelsDir();
  if (dir.exists) dir.delete();
}

/** "a.gguf.part10" 이 "a.gguf.part9" 뒤에 오도록 숫자 인식 정렬 */
const naturalSort = (a: File, b: File) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

const isChecksumFile = (f: File) => /(\.sha256|sha256sums(\.txt)?)$/i.test(f.name);

/** 조각 이름에서 원래 파일명을 추정: x.gguf.part00 → x.gguf, x.zip.001 → x.zip, x.gguf.aa → x.gguf */
function guessBaseName(first: File): string {
  const n = first.name
    .replace(/\.(part|p)?[-_]?\d{1,4}$/i, '')
    .replace(/(\.(gguf|zip))\.[a-z]{2}$/i, '$1');
  return n || DEFAULT_MODEL_NAME;
}

/** 여러 파일을 dest 하나로 이어 붙임 (메모리에 전부 올리지 않고 8MiB씩 스트리밍) */
async function concatFiles(sources: File[], dest: File, onProgress: OnProgress) {
  const total = sources.reduce((s, f) => s + (f.size ?? 0), 0);
  let done = 0;
  if (dest.exists) dest.delete();
  dest.create({ intermediates: true });
  const out = dest.open(FileMode.WriteOnly);
  try {
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const inp = src.open(FileMode.ReadOnly);
      try {
        for (;;) {
          const bytes = await inp.readBytes(CHUNK);
          if (bytes.length === 0) break;
          await out.writeBytes(bytes);
          done += bytes.length;
          onProgress({
            stage: sources.length > 1 ? 'joining' : 'copying',
            ratio: total ? done / total : 0,
            detail: `${i + 1}/${sources.length} ${src.name}`,
          });
        }
      } finally {
        inp.close();
      }
    }
  } finally {
    out.close();
  }
  if (total && dest.size !== total) {
    throw new Error(`이어 붙인 크기가 다릅니다 (기대 ${total}, 실제 ${dest.size}). 조각이 손상되었을 수 있습니다.`);
  }
}

function findFileRecursive(dir: Directory, pred: (f: File) => boolean): File | null {
  for (const e of dir.list()) {
    if (e instanceof File && pred(e)) return e;
    if (e instanceof Directory) {
      const r = findFileRecursive(e, pred);
      if (r) return r;
    }
  }
  return null;
}

async function unzipModel(zip: File, onProgress: OnProgress): Promise<File> {
  const outDir = new Directory(workDir(), 'unzipped');
  if (outDir.exists) outDir.delete();
  ensureDir(outDir);
  const sub = subscribeZip(({ progress }) =>
    onProgress({ stage: 'unzipping', ratio: progress, detail: zip.name }),
  );
  try {
    await unzip(toNativePath(zip.uri), toNativePath(outDir.uri));
  } finally {
    sub.remove();
  }
  const gguf = findFileRecursive(
    outDir,
    (f) => f.name.toLowerCase().endsWith('.gguf') && !/mmproj/i.test(f.name),
  );
  if (!gguf) throw new Error('zip 안에서 .gguf 파일을 찾지 못했습니다.');
  return gguf;
}

async function parseChecksums(files: File[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of files) {
    const text = await f.text();
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
      if (m) map.set(m[2].trim().split('/').pop()!, m[1].toLowerCase());
      else if (/^[a-f0-9]{64}$/i.test(line.trim())) map.set('*', line.trim().toLowerCase());
    }
  }
  return map;
}

/**
 * 사용자가 고른(또는 import 폴더에 넣은) 파일들로 모델을 설치한다.
 */
export async function installFromFiles(
  picked: File[],
  onProgress: OnProgress,
  opts: { consumeSources?: boolean } = {},
): Promise<InstalledModel> {
  onProgress({ stage: 'checking', ratio: 0 });
  const checksumFiles = picked.filter(isChecksumFile);
  const parts = picked.filter((f) => !isChecksumFile(f)).sort(naturalSort);
  if (parts.length === 0) throw new Error('모델 파일(.gguf / .zip / 분할 조각)을 선택하세요.');

  const totalIn = parts.reduce((s, f) => s + (f.size ?? 0), 0);
  const firstMagic = await readMagic(parts[0]);
  const isZip = startsWith(firstMagic, ZIP_MAGIC);
  const isGguf = startsWith(firstMagic, GGUF_MAGIC);
  if (!isZip && !isGguf) {
    throw new Error(
      `첫 번째 조각(${parts[0].name})이 GGUF/ZIP 헤더로 시작하지 않습니다. 조각을 모두 선택했는지, 순서(이름)가 맞는지 확인하세요.`,
    );
  }

  // 여유 공간 확인 (zip 은 압축 파일 + 해제본이 동시에 필요)
  const need = isZip ? totalIn * 2.05 : totalIn * 1.02;
  const free = Paths.availableDiskSpace;
  if (free > 0 && free < need) {
    throw new Error(`저장 공간 부족: 필요 약 ${formatBytes(need)}, 남은 공간 ${formatBytes(free)}`);
  }

  const work = workDir();
  if (work.exists) work.delete();
  ensureDir(work);
  ensureDir(modelsDir());

  try {
    const baseName = guessBaseName(parts[0]);
    const joined = new File(work, isZip ? (baseName.endsWith('.zip') ? baseName : 'model.zip') : baseName);
    if (opts.consumeSources && parts.length === 1) {
      // 앱 저장소 안에 이미 있는 단일 파일은 복사하지 않고 옮긴다 (공간·시간 절약)
      onProgress({ stage: 'copying', ratio: 0, detail: parts[0].name });
      await parts[0].move(joined);
    } else {
      await concatFiles(parts, joined, onProgress);
    }

    const gguf = isZip ? await unzipModel(joined, onProgress) : joined;
    if (!startsWith(await readMagic(gguf), GGUF_MAGIC)) {
      throw new Error('결과 파일이 올바른 GGUF 형식이 아닙니다.');
    }
    const finalName = gguf.name.toLowerCase().endsWith('.gguf') ? gguf.name : DEFAULT_MODEL_NAME;

    if (checksumFiles.length) {
      onProgress({ stage: 'verifying', ratio: 0, detail: 'SHA-256 계산 중…' });
      const sums = await parseChecksums(checksumFiles);
      const expected = sums.get(finalName) ?? sums.get(guessBaseName(parts[0])) ?? sums.get('*');
      if (expected) {
        const actual = (await gguf.digest('SHA-256')).toLowerCase();
        if (actual !== expected) {
          throw new Error(`SHA-256 불일치\n기대: ${expected}\n실제: ${actual}`);
        }
      }
      onProgress({ stage: 'verifying', ratio: 1 });
    }

    // 기존 모델 교체
    for (const e of modelsDir().list()) e.delete();
    const dest = new File(modelsDir(), finalName);
    await gguf.move(dest);

    if (opts.consumeSources) {
      for (const f of [...parts, ...checksumFiles]) if (f.exists) f.delete();
    }

    onProgress({ stage: 'done', ratio: 1 });
    const installed = new File(modelsDir(), finalName);
    return { file: installed, path: toNativePath(installed.uri), name: installed.name, size: installed.size ?? 0 };
  } finally {
    if (work.exists) work.delete();
  }
}

/** 파일 선택기 (Android: 저장소 접근 프레임워크, iOS: 파일 앱). 여러 개 선택 가능 */
export async function pickModelFiles(): Promise<File[] | null> {
  const res = await File.pickFileAsync({ multipleFiles: true });
  if (res.canceled) return null;
  return res.result;
}

/**
 * iOS: Finder(맥) 또는 파일 앱 > "나의 iPhone" > Gemma Chat 폴더에 직접 넣은 파일들.
 * (Documents 최상위의 파일만 대상, models/ 등 하위 폴더는 제외)
 */
export function listInboxFiles(): File[] {
  return new Directory(Paths.document)
    .list()
    .filter((e): e is File => e instanceof File && !e.name.startsWith('.'));
}

/** 파일 선택기가 앱 캐시에 만든 임시 사본 정리 (iOS 는 선택한 파일을 캐시로 복사함) */
export function cleanupPickedCopies(files: File[]) {
  const cache = Paths.cache.uri;
  for (const f of files) {
    try {
      if (f.uri.startsWith(cache) && f.exists) f.delete();
    } catch {
      // 무시
    }
  }
}

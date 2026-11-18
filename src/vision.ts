/**
 * 이미지(카메라·사진) 기능.
 *
 * - Gemma 3 4B 는 이미지를 이해하는 모델이다. 이미지를 쓰려면 비전 프로젝터(mmproj, 약 0.85GB)가 더 필요하다.
 *   처음 사진 기능을 쓸 때 GitHub Release(model-v1/vision.json)에서 한 번 받는다. 이후 처리는 기기 안에서만 한다.
 * - 사진은 긴 변 1024px JPEG 로 줄여 앱 저장소(Documents/chat-images)에 보관한다.
 *   (Gemma 3 는 내부적으로 896px 로 보므로 그보다 크게 넣어도 정확도는 같고 느리기만 하다)
 */
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { DownloadCancelled, MODEL_RELEASE_URL, speedMeter } from './modelDownload';
import { RangedCancelled, downloadRanged } from './rangedDownload';
import { ensureDir, formatBytes, isGguf, readMagic, toNativePath, type OnProgress } from './modelStore';
import { APP_NAME } from './storeConfig';

type VisionManifest = { format: number; name: string; size: number; sha256: string };

const visionDir = () => new Directory(Paths.document, 'vision');
const imagesDir = () => new Directory(Paths.document, 'chat-images');

export type InstalledVision = { path: string; name: string; size: number };

export function findInstalledVision(): InstalledVision | null {
  const d = visionDir();
  if (!d.exists) return null;
  const f = d
    .list()
    .find((e): e is File => e instanceof File && e.name.toLowerCase().endsWith('.gguf') && !e.name.startsWith('.'));
  return f ? { path: toNativePath(f.uri), name: f.name, size: f.size ?? 0 } : null;
}

export function deleteVision() {
  const d = visionDir();
  if (d.exists) d.delete();
}

export async function fetchVisionManifest(signal: AbortSignal): Promise<VisionManifest> {
  let res: Response;
  try {
    res = await fetch(`${MODEL_RELEASE_URL}/vision.json`, { signal, cache: 'no-store' });
  } catch (e: any) {
    if (signal.aborted) throw new DownloadCancelled();
    throw new Error(`서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.\n(${e?.message ?? e})`);
  }
  if (res.status === 404) {
    throw new Error('이미지 인식 파일이 아직 GitHub Release 에 없습니다.\n저장소 Actions › "Publish vision model" 을 먼저 실행해야 합니다.');
  }
  if (!res.ok) throw new Error(`이미지 인식 파일 정보를 받지 못했습니다 (HTTP ${res.status}).`);
  const m = (await res.json()) as VisionManifest;
  if (!m?.name?.endsWith('.gguf') || !m.size) throw new Error('vision.json 형식이 올바르지 않습니다.');
  return m;
}

/** 비전 프로젝터를 받아 설치한다. 32MB 조각 단위로 받고, 끊겨도 받은 곳부터 이어 받는다. */
export async function downloadVision(onProgress: OnProgress, signal: AbortSignal): Promise<InstalledVision> {
  onProgress({ stage: 'checking', ratio: 0, detail: '이미지 인식 파일 확인 중' });
  const m = await fetchVisionManifest(signal);

  const dir = visionDir();
  ensureDir(dir);
  // 이전에 받다 만 파일은 이어 받는다 (다른 파일이면 지운다)
  const partial = new File(dir, `.${m.name}.part`);
  for (const e of dir.list()) if (e instanceof File && e.uri !== partial.uri) e.delete();

  const have = partial.exists ? partial.size ?? 0 : 0;
  const free = Paths.availableDiskSpace;
  if (free > 0 && free < m.size - have + 100 * 1024 * 1024) {
    throw new Error(`저장 공간 부족: 약 ${formatBytes(m.size - have)} 필요, 남은 공간 ${formatBytes(free)}`);
  }

  const speed = speedMeter();
  try {
    await downloadRanged(
      [{ url: `${MODEL_RELEASE_URL}/${encodeURIComponent(m.name)}`, size: m.size }],
      partial,
      new File(dir, '.chunk'),
      (done, total, note) =>
        onProgress({
          stage: 'downloading',
          ratio: total ? done / total : 0,
          detail: note ?? `${formatBytes(done)} / ${formatBytes(total)}${speed(done)}`,
        }),
      signal,
    );
  } catch (e: any) {
    if (e instanceof RangedCancelled || signal.aborted) throw new DownloadCancelled();
    throw new Error(`이미지 인식 파일 다운로드 실패: ${e?.message ?? e}\n다시 시도하면 받은 곳부터 이어 받습니다.`);
  }

  onProgress({ stage: 'verifying', ratio: 1, detail: 'SHA-256 검사 중' });
  const hash = (await partial.digest('SHA-256')).toLowerCase();
  if (partial.size !== m.size || hash !== m.sha256.toLowerCase() || !isGguf(await readMagic(partial))) {
    partial.delete();
    throw new Error('받은 이미지 인식 파일이 손상되었습니다. 다시 시도하세요.');
  }
  await partial.move(new File(dir, m.name));
  onProgress({ stage: 'done', ratio: 1 });
  const installed = new File(dir, m.name);
  return { path: toNativePath(installed.uri), name: installed.name, size: installed.size ?? 0 };
}

export type ImageSource = 'camera' | 'library';

/**
 * 카메라로 찍거나 앨범에서 골라, 1024px JPEG 로 줄여 앱 저장소에 저장한 뒤 file:// URI 를 돌려준다.
 * 취소하면 null.
 */
export async function pickImage(source: ImageSource): Promise<string | null> {
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error(`카메라 권한이 필요합니다. 설정 › ${APP_NAME}에서 카메라를 허용하세요.`);
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false };
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (r.canceled || !r.assets?.length) return null;
  const a = r.assets[0];

  const MAX = 1024;
  const longest = Math.max(a.width || 0, a.height || 0);
  const ctx = ImageManipulator.manipulate(a.uri);
  if (longest > MAX) {
    if ((a.width || 0) >= (a.height || 0)) ctx.resize({ width: MAX });
    else ctx.resize({ height: MAX });
  }
  const img = await ctx.renderAsync();
  const saved = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });

  const dir = imagesDir();
  ensureDir(dir);
  const dest = new File(dir, `${Date.now().toString(36)}.jpg`);
  await new File(saved.uri).move(dest);
  return new File(dir, dest.name).uri;
}

/** 대화에서 더 이상 쓰지 않는 사진 지우기 */
export function deleteImages(keep: string[] = []) {
  const d = imagesDir();
  if (!d.exists) return;
  const keepSet = new Set(keep);
  for (const e of d.list()) if (e instanceof File && !keepSet.has(e.uri)) e.delete();
}

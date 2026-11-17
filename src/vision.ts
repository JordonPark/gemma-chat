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
import { DownloadCancelled, MAX_ATTEMPTS, MODEL_RELEASE_URL, downloadPart, sleep } from './modelDownload';
import { ensureDir, formatBytes, isGguf, readMagic, toNativePath, type OnProgress } from './modelStore';

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

async function fetchVisionManifest(signal: AbortSignal): Promise<VisionManifest> {
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

/** 비전 프로젝터를 받아 설치한다 (실패하면 3번까지 다시 시도) */
export async function downloadVision(onProgress: OnProgress, signal: AbortSignal): Promise<InstalledVision> {
  onProgress({ stage: 'checking', ratio: 0, detail: '이미지 인식 파일 확인 중' });
  const m = await fetchVisionManifest(signal);

  const free = Paths.availableDiskSpace;
  if (free > 0 && free < m.size + 100 * 1024 * 1024) {
    throw new Error(`저장 공간 부족: 약 ${formatBytes(m.size)} 필요, 남은 공간 ${formatBytes(free)}`);
  }

  const dir = visionDir();
  if (dir.exists) dir.delete();
  ensureDir(dir);
  const url = `${MODEL_RELEASE_URL}/${encodeURIComponent(m.name)}`;
  const tmp = new File(dir, `.${m.name}.part`);

  for (let attempt = 1; ; attempt++) {
    let last = 0;
    try {
      if (tmp.exists) tmp.delete();
      onProgress({ stage: 'downloading', ratio: 0, detail: `연결 중…${attempt > 1 ? ` (재시도 ${attempt - 1})` : ''}` });
      await downloadPart(
        url,
        tmp,
        (n) => {
          const now = Date.now();
          if (now - last < 250) return;
          last = now;
          onProgress({ stage: 'downloading', ratio: n / m.size, detail: `${formatBytes(n)} / ${formatBytes(m.size)}` });
        },
        signal,
      );
      break;
    } catch (e: any) {
      if (e instanceof DownloadCancelled || signal.aborted) {
        if (dir.exists) dir.delete();
        throw new DownloadCancelled();
      }
      if (attempt >= MAX_ATTEMPTS) {
        if (dir.exists) dir.delete();
        throw new Error(`이미지 인식 파일 다운로드 실패: ${e?.message ?? e}`);
      }
      await sleep(3000 * attempt);
    }
  }

  onProgress({ stage: 'verifying', ratio: 1, detail: 'SHA-256 검사 중' });
  const hash = (await tmp.digest('SHA-256')).toLowerCase();
  if (tmp.size !== m.size || hash !== m.sha256.toLowerCase() || !isGguf(await readMagic(tmp))) {
    dir.delete();
    throw new Error('받은 이미지 인식 파일이 손상되었습니다. 다시 시도하세요.');
  }
  const dest = new File(dir, m.name);
  await tmp.move(dest);
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
    if (!perm.granted) throw new Error('카메라 권한이 필요합니다. 설정 › Gemma Chat 에서 카메라를 허용하세요.');
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

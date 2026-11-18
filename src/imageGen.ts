/**
 * iPhone 기기 안 그림 생성 (Stable Diffusion 1.5, Apple Core ML, Neural Engine). 그림체는 DRAW_STYLES 에서 고른다.
 *
 * - 모델(약 2.7GB zip, 2GiB 미만 조각)은 처음 그릴 때 GitHub Release(model-v1/sd.json)에서 한 번 받아 기기에서 압축을 푼다.
 * - 그리는 동안 메모리를 확보하려고 채팅 모델(Gemma)을 잠시 내렸다가 다 그리면 다시 올린다 (호출하는 쪽에서 처리).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { subscribe as subscribeZip, unzip } from 'react-native-zip-archive';
import {
  cancelImageGen,
  generateImage,
  isImageGenAvailable,
  loadImageModel,
  unloadImageModel,
  type SdProgress,
} from '../modules/expo-sd';
import { DownloadCancelled, MODEL_RELEASE_URL, speedMeter } from './modelDownload';
import { ensureDir, formatBytes, toNativePath, type OnProgress } from './modelStore';
import { RangedCancelled, downloadRanged } from './rangedDownload';

export { cancelImageGen, isImageGenAvailable };

type SdManifest = {
  format: number;
  id?: string;
  /** 합친 zip 이름 */
  name: string;
  size: number;
  sha256: string;
  /** 2GiB 넘는 모델은 조각으로 올린다 (format 2) */
  parts?: { name: string; size: number }[];
  model?: string;
};

const sdDir = () => new Directory(Paths.document, 'sd');
/** 설치된 그림 모델 정보 (sd.json 의 id/name/model). 표시가 없으면 처음 배포했던 기본 SD 1.5 */
const markerFile = () => new File(sdDir(), '.model.json');

export function installedImageModelId(): string | null {
  if (!findInstalledImageModel()) return null;
  try {
    const f = markerFile();
    return f.exists ? (JSON.parse(f.textSync()).id as string) ?? 'sd15' : 'sd15';
  } catch {
    return 'sd15';
  }
}

export type ImageModelUpdate = { id: string; size: number; model: string };

/** Release 의 그림 모델이 설치된 것과 다르면 그 정보를 돌려준다 (오프라인이면 null) */
export async function checkImageModelUpdate(): Promise<ImageModelUpdate | null> {
  const installed = installedImageModelId();
  if (!installed) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const m = await fetchSdManifest(ac.signal);
    const id = m.id ?? 'sd15';
    return id !== installed ? { id, size: m.size, model: m.model ?? m.name } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
const picturesDir = () => new Directory(Paths.document, 'pictures');

/** 리소스 폴더(Unet.mlmodelc 가 있는 폴더)를 찾는다 */
function findResourcesDir(d: Directory, depth = 0): Directory | null {
  if (!d.exists || depth > 3 || d.name === '__MACOSX') return null;
  const entries = d.list();
  const unet = entries.find((e): e is Directory => e instanceof Directory && /^Unet(Chunk1)?\.mlmodelc$/.test(e.name));
  // 진짜 모델 폴더인지: Unet 가중치가 있어야 한다 (macOS 가 zip 에 넣는 __MACOSX 사본 등은 건너뜀)
  if (unet && new File(unet, 'weights', 'weight.bin').exists) return d;
  for (const e of entries) {
    if (e instanceof Directory && !e.name.endsWith('.mlmodelc') && e.name !== '__MACOSX') {
      const r = findResourcesDir(e, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** 설치된 그림 모델의 리소스 폴더 경로 (없으면 null) */
export function findInstalledImageModel(): string | null {
  const r = findResourcesDir(sdDir());
  return r ? toNativePath(r.uri) : null;
}

/**
 * 쓰지 않는 부분 지우기: VAEEncoder 는 그림→그림 변환에만 쓰여서 이 앱에는 필요 없다 (파이프라인도 없으면 건너뜀).
 * 받다 만 zip·조각 잔여물도 지운다.
 */
export function trimImageModel() {
  const dir = sdDir();
  const r = findResourcesDir(dir);
  if (!r) return;
  const enc = new Directory(r, 'VAEEncoder.mlmodelc');
  if (enc.exists) enc.delete();
  for (const e of dir.list()) if (e instanceof File && e.name.startsWith('.') && e.name !== '.model.json') e.delete();
}

export function deleteImageModel() {
  const d = sdDir();
  if (d.exists) d.delete();
}

async function fetchSdManifest(signal: AbortSignal): Promise<SdManifest> {
  let res: Response;
  try {
    res = await fetch(`${MODEL_RELEASE_URL}/sd.json`, { signal, cache: 'no-store' });
  } catch (e: any) {
    if (signal.aborted) throw new DownloadCancelled();
    throw new Error(`서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.\n(${e?.message ?? e})`);
  }
  if (res.status === 404) throw new Error('그림 모델이 아직 GitHub Release 에 없습니다 (Actions › "Publish image model").');
  if (!res.ok) throw new Error(`그림 모델 정보를 받지 못했습니다 (HTTP ${res.status}).`);
  const m = (await res.json()) as SdManifest;
  if (!m?.name?.endsWith('.zip') || !m.size) throw new Error('sd.json 형식이 올바르지 않습니다.');
  return m;
}

/** 그림 모델을 받아 압축을 풀고 리소스 폴더 경로를 돌려준다. 끊겨도 받은 곳부터 이어 받는다. */
export async function downloadImageModel(onProgress: OnProgress, signal: AbortSignal): Promise<string> {
  onProgress({ stage: 'checking', ratio: 0, detail: '그림 모델 확인 중' });
  const m = await fetchSdManifest(signal);

  const dir = sdDir();
  ensureDir(dir);
  const zip = new File(dir, `.${m.name}.part`);
  // 받다 만 zip 말고 다른 것(예전 압축 해제 잔여물)은 지운다
  for (const e of dir.list()) if (!(e instanceof File && e.uri === zip.uri)) e.delete();

  const have = zip.exists ? zip.size ?? 0 : 0;
  const need = m.size - have + m.size * 1.05 + 200 * 1024 * 1024; // zip + 압축 푼 크기
  const free = Paths.availableDiskSpace;
  if (free > 0 && free < need) {
    throw new Error(`저장 공간 부족: 약 ${formatBytes(need)} 필요, 남은 공간 ${formatBytes(free)}`);
  }

  const speed = speedMeter(m.size);
  try {
    const sources = m.parts?.length
      ? m.parts.map((p) => ({ url: `${MODEL_RELEASE_URL}/${encodeURIComponent(p.name)}`, size: p.size }))
      : [{ url: `${MODEL_RELEASE_URL}/${encodeURIComponent(m.name)}`, size: m.size }];
    await downloadRanged(
      sources,
      zip,
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
    throw new Error(`그림 모델 다운로드 실패: ${e?.message ?? e}\n다시 시도하면 받은 곳부터 이어 받습니다.`);
  }

  onProgress({ stage: 'verifying', ratio: 1, detail: 'SHA-256 검사 중 (1분 정도)' });
  const hash = (await zip.digest('SHA-256')).toLowerCase();
  if (zip.size !== m.size || hash !== m.sha256.toLowerCase()) {
    zip.delete();
    throw new Error('받은 그림 모델이 손상되었습니다. 다시 시도하세요.');
  }

  onProgress({ stage: 'unzipping', ratio: 0, detail: '압축 푸는 중' });
  const sub = subscribeZip(({ progress }) => onProgress({ stage: 'unzipping', ratio: progress, detail: '압축 푸는 중' }));
  try {
    await unzip(toNativePath(zip.uri), toNativePath(dir.uri));
  } finally {
    sub.remove();
  }
  zip.delete();
  for (const e of dir.list()) if (e instanceof Directory && e.name === '__MACOSX') e.delete();
  trimImageModel();
  const res = findInstalledImageModel();
  if (!res) {
    deleteImageModel();
    throw new Error('압축을 풀었지만 그림 모델 파일을 찾지 못했습니다.');
  }
  try {
    const mk = markerFile();
    if (!mk.exists) mk.create();
    mk.writeSync(JSON.stringify({ id: m.id ?? 'sd15', name: m.name, sha256: m.sha256, model: m.model ?? '' }));
  } catch {
    // 표시를 못 써도 그림은 그릴 수 있다
  }
  onProgress({ stage: 'done', ratio: 1 });
  return res;
}

// ───────────── 그림체 ─────────────

const BASE_NEGATIVE =
  'text, letters, watermark, signature, logo, frame, border, blurry, lowres, jpeg artifacts, deformed, disfigured, bad anatomy, extra limbs, extra fingers, mutated hands, ugly, nsfw';

export type DrawStyleId = 'anime' | '3d' | 'flat' | 'pencil' | 'pixel' | 'photo' | 'watercolor';

export type DrawStyle = {
  id: DrawStyleId;
  label: string;
  /** 요청 문장에 이 말이 있으면 이 그림체로 그린다 (예: "픽셀아트로 고양이 그려줘") */
  keywords: RegExp;
  suffix: string;
  negative: string;
  guidance: number;
};

export const DRAW_STYLES: DrawStyle[] = [
  {
    id: 'anime',
    label: '애니·웹툰',
    keywords: /애니|웹툰|만화|아니메/,
    suffix: 'anime style illustration, webtoon, clean line art, cel shading, vibrant colors, expressive eyes, detailed background, high quality',
    negative: 'photo, photorealistic, realistic, 3d render, cgi',
    guidance: 7.5,
  },
  {
    id: '3d',
    label: '3D 캐릭터',
    keywords: /3d|3D|입체|피규어/,
    suffix: '3d animated movie style, stylized cute cartoon character, soft studio lighting, smooth shading, subsurface scattering, vibrant colors, high quality render',
    negative: 'photo, photorealistic, 2d, flat, sketch, anime',
    guidance: 7.0,
  },
  {
    id: 'flat',
    label: '플랫 일러스트',
    keywords: /플랫|벡터|아이콘|미니멀/,
    suffix: 'flat vector illustration, clean simple shapes, bold flat colors, minimal, graphic design, centered composition, high quality',
    negative: 'photo, photorealistic, realistic, 3d render, gradient noise, texture, sketch',
    guidance: 7.5,
  },
  {
    id: 'pencil',
    label: '색연필',
    keywords: /색연필|연필|스케치|크레파스/,
    suffix: 'colored pencil drawing, hand-drawn illustration, soft shading, visible pencil strokes, paper texture, cute, warm colors',
    negative: 'photo, photorealistic, 3d render, digital painting, vector',
    guidance: 7.0,
  },
  {
    id: 'pixel',
    label: '픽셀아트',
    keywords: /픽셀|도트|레트로 게임/,
    suffix: 'pixel art, 16-bit retro video game style, crisp pixels, limited color palette, clean sprite, game scene',
    negative: 'photo, photorealistic, 3d render, smooth gradient, blurry, painting',
    guidance: 8.0,
  },
  {
    id: 'photo',
    label: '사진처럼',
    keywords: /사진|실사|리얼|진짜처럼/,
    suffix: 'photograph, realistic, natural lighting, 50mm lens, shallow depth of field, highly detailed, sharp focus',
    negative: 'cartoon, anime, drawing, painting, illustration, 3d render, cgi',
    guidance: 7.0,
  },
  {
    id: 'watercolor',
    label: '수채화 동화',
    keywords: /수채화|동화/,
    suffix: "watercolor children's storybook illustration, soft pastel colors, gentle warm light, hand-painted paper texture, whimsical, cute",
    negative: 'photo, photorealistic, realistic, 3d render, cgi, dark, gloomy',
    guidance: 7.5,
  },
];

export const DEFAULT_DRAW_STYLE: DrawStyleId = 'anime';

export const getDrawStyle = (id?: string) => DRAW_STYLES.find((s) => s.id === id) ?? DRAW_STYLES[0];

/** 요청 문장에 그림체를 말했으면 그걸, 아니면 설정의 기본 그림체 */
export function pickDrawStyle(request: string, fallback?: string): DrawStyle {
  return DRAW_STYLES.find((s) => s.keywords.test(request)) ?? getDrawStyle(fallback);
}

export type DrawStage = 'loading' | 'generating';

/**
 * 영어 프롬프트로 그림을 만든다. 첫 실행은 Neural Engine 준비로 1~3분 더 걸린다.
 * 결과는 Documents/pictures/*.png 에 저장된다.
 */
export async function drawPicture(
  englishPrompt: string,
  style: DrawStyle,
  onStage: (stage: DrawStage, p?: SdProgress) => void,
): Promise<string> {
  const res = findInstalledImageModel();
  if (!res) throw new Error('그림 모델이 설치되어 있지 않습니다.');
  onStage('loading');
  await loadImageModel(res);
  const dir = picturesDir();
  ensureDir(dir);
  const out = new File(dir, `${Date.now().toString(36)}.png`);
  onStage('generating', { step: 0, stepCount: 25 });
  try {
    const r = await generateImage(
      {
        prompt: `${englishPrompt}, ${style.suffix}`,
        negativePrompt: `${style.negative}, ${BASE_NEGATIVE}`,
        steps: 25,
        guidance: style.guidance,
        outputPath: out.uri,
      },
      (p) => onStage('generating', p),
    );
    return r.uri;
  } finally {
    await unloadImageModel().catch(() => {});
  }
}

/**
 * 그림 모델을 미리 준비한다 (Neural Engine 용 컴파일). 기기마다 처음 한 번 1~3분 걸리고, 결과는 iOS 가 캐시한다.
 * 다 받은 직후에 불러 두면 첫 그림부터 바로 그릴 수 있다. 메모리를 위해 채팅 모델은 호출하는 쪽에서 내려 둔다.
 */
export async function prepareImageModel(): Promise<void> {
  const res = findInstalledImageModel();
  if (!res) throw new Error('그림 모델이 설치되어 있지 않습니다.');
  try {
    await loadImageModel(res);
  } finally {
    await unloadImageModel().catch(() => {});
  }
}

export function deletePictures(keep: string[] = []) {
  const d = picturesDir();
  if (!d.exists) return;
  const k = new Set(keep);
  for (const e of d.list()) if (e instanceof File && !k.has(e.uri)) e.delete();
}

/**
 * 기기 안 이미지 생성 (iOS 전용: Apple Core ML Stable Diffusion, Neural Engine).
 * Android 나 이 모듈이 없는 예전 앱에서는 isImageGenAvailable() 가 false.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type SdProgress = { step: number; stepCount: number };
export type SdGenerateOptions = {
  prompt: string;
  negativePrompt?: string;
  steps?: number;
  guidance?: number;
  seed?: number;
  /** 결과 PNG 경로 (file://…) */
  outputPath: string;
};

type NativeSd = {
  load(resourcesPath: string, useGpu?: boolean): Promise<void>;
  generate(options: SdGenerateOptions): Promise<{ uri: string; seed: number }>;
  cancel(): void;
  unload(): Promise<void>;
  addListener(event: 'onProgress', cb: (p: SdProgress) => void): { remove(): void };
};

const native = requireOptionalNativeModule<NativeSd>('ExpoSd');

export const isImageGenAvailable = () => native != null;

function need(): NativeSd {
  if (!native) throw new Error('이 기기·앱 버전에서는 이미지 생성을 쓸 수 없습니다.');
  return native;
}

/** useGpu: Neural Engine 대신 GPU 로 (Neural Engine 준비가 멈추는 경우의 대안) */
export const loadImageModel = (resourcesPath: string, useGpu = false) =>
  useGpu ? need().load(resourcesPath, true) : need().load(resourcesPath);
export const unloadImageModel = () => (native ? native.unload() : Promise.resolve());
export const cancelImageGen = () => native?.cancel();

export async function generateImage(opts: SdGenerateOptions, onProgress?: (p: SdProgress) => void) {
  const n = need();
  const sub = onProgress ? n.addListener('onProgress', onProgress) : null;
  try {
    return await n.generate({ negativePrompt: '', steps: 25, guidance: 7.5, seed: -1, ...opts });
  } finally {
    sub?.remove();
  }
}

/**
 * 기기 메모리 확인. Gemma 3 4B(약 2.4GB) + 사진 인식(0.8GB) + 대화 캐시를 올리려면 RAM 6GB 이상이 필요하다.
 * RAM 4GB 이하 기기에서 모델을 올리면 메모리 부족으로 앱이 강제 종료되므로, 처음에 안내하고 막는다.
 * (expo-device 가 없는 예전 앱 빌드에서는 확인하지 않는다)
 */
import { File, Paths } from 'expo-file-system';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/** 6GB 기기는 보통 5.4~5.8GB 로 보고되고, 4GB 기기는 3.6~3.9GB 로 보고된다 */
const MIN_MEMORY_BYTES = 5_000_000_000;
export const ANDROID_COMPACT_MEMORY_BYTES = 8 * 1024 ** 3;

export function deviceMemoryBytes(): number | null {
  try {
    const v = requireOptionalNativeModule<{ totalMemory?: number }>('ExpoDevice')?.totalMemory;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function isMemoryConstrainedAndroid(): boolean {
  if (Platform.OS !== 'android') return false;
  const memory = deviceMemoryBytes();
  return memory !== null && memory <= ANDROID_COMPACT_MEMORY_BYTES;
}

export function deviceModelName(): string | null {
  try {
    return requireOptionalNativeModule<{ modelName?: string }>('ExpoDevice')?.modelName?.trim() || null;
  } catch {
    return null;
  }
}

const overrideFile = () => new File(Paths.document, '.low-memory-ok');

/** 메모리가 모자란 기기이고, 사용자가 "그래도 계속"을 고르지 않았으면 true */
export function shouldWarnLowMemory(): boolean {
  const mem = deviceMemoryBytes();
  if (mem == null || mem >= MIN_MEMORY_BYTES) return false;
  try {
    return !overrideFile().exists;
  } catch {
    return true;
  }
}

export function acceptLowMemory() {
  try {
    const f = overrideFile();
    if (!f.exists) f.create();
  } catch {}
}

export function formatMemory(bytes: number | null): string {
  return bytes == null ? '알 수 없음' : `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

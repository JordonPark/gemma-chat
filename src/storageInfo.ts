/** 앱이 쓰는 저장 공간 내역과 임시 파일 정리 */
import { Directory, Paths } from 'expo-file-system';

export type StorageItem = { key: string; label: string; bytes: number };

const dirSize = (name: string): number => {
  try {
    const d = new Directory(Paths.document, name);
    return d.exists ? Number(d.size ?? 0) : 0;
  } catch {
    return 0;
  }
};

/** 받다 만 파일·압축 잔여물 (지워도 되는 것) */
const TEMP_DIRS = ['.download', '.import-work'];

export function storageBreakdown(): { items: StorageItem[]; total: number; free: number } {
  const items: StorageItem[] = [
    { key: 'models', label: '채팅 모델 (Gemma 3 4B)', bytes: dirSize('models') },
    { key: 'vision', label: '이미지 인식 파일', bytes: dirSize('vision') },
    { key: 'media', label: '대화 사진', bytes: dirSize('chat-images') + dirSize('pictures') },
    { key: 'temp', label: '임시 파일 (받다 만 파일 등)', bytes: TEMP_DIRS.reduce((s, n) => s + dirSize(n), 0) },
  ].filter((i) => i.bytes > 0);
  return { items, total: items.reduce((s, i) => s + i.bytes, 0), free: Paths.availableDiskSpace };
}

/** 임시 파일 정리. 다운로드 중에는 부르지 말 것 (이어받기 파일도 지워진다) */
export function clearTempFiles(): number {
  let freed = 0;
  for (const n of TEMP_DIRS) {
    const d = new Directory(Paths.document, n);
    if (d.exists) {
      freed += Number(d.size ?? 0);
      d.delete();
    }
  }
  return freed;
}

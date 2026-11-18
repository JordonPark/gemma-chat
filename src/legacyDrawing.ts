/**
 * 그림 그리기 기능은 앱 용량·메모리 부담으로 뺐다.
 * 예전 버전에서 받은 그림 모델(약 1~2.5GB)은 앱을 열 때 지우고, 예전 대화의 그림 파일은 새 대화를 시작할 때 지운다.
 */
import { Directory, File, Paths } from 'expo-file-system';

/** 예전 그림 모델 폴더(Documents/sd)를 지운다. 지운 바이트 수 */
export function removeLegacyImageModel(): number {
  try {
    const d = new Directory(Paths.document, 'sd');
    if (!d.exists) return 0;
    const size = Number(d.size ?? 0);
    d.delete();
    return size;
  } catch {
    return 0;
  }
}

/** 예전에 생성한 그림 파일 지우기 (keep 에 있는 것은 남긴다) */
export function deletePictures(keep: string[] = []) {
  const d = new Directory(Paths.document, 'pictures');
  if (!d.exists) return;
  const k = new Set(keep);
  for (const e of d.list()) if (e instanceof File && !k.has(e.uri)) e.delete();
}

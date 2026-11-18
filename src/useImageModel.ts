/** 그림 모델(Stable Diffusion, iOS) 설치 상태: 확인 · 받기 · 지우기 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { deleteImageModel, downloadImageModel, findInstalledImageModel, isImageGenAvailable, trimImageModel } from './imageGen';
import { DownloadCancelled } from './modelDownload';
import type { ImportProgress } from './modelStore';

export type ImageModelStatus =
  | { kind: 'unsupported' } // Android 등: 이미지 생성 모듈 없음 → 도형 일러스트로 대신
  | { kind: 'missing' }
  | { kind: 'ready'; path: string }
  | { kind: 'downloading'; progress: ImportProgress | null };

export function useImageModel() {
  const [status, setStatus] = useState<ImageModelStatus>(() => {
    if (!isImageGenAvailable()) return { kind: 'unsupported' };
    const p = findInstalledImageModel();
    return p ? { kind: 'ready', path: p } : { kind: 'missing' };
  });
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (!isImageGenAvailable()) return setStatus({ kind: 'unsupported' });
    try {
      trimImageModel(); // 이미 설치된 모델에서도 안 쓰는 부분 정리
    } catch {}
    const p = findInstalledImageModel();
    setStatus(p ? { kind: 'ready', path: p } : { kind: 'missing' });
  }, []);
  useEffect(refresh, [refresh]);

  const download = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus({ kind: 'downloading', progress: null });
    await activateKeepAwakeAsync('sd-download');
    try {
      const path = await downloadImageModel((p) => setStatus({ kind: 'downloading', progress: p }), ac.signal);
      setStatus({ kind: 'ready', path });
    } catch (e: any) {
      setStatus({ kind: 'missing' });
      if (!(e instanceof DownloadCancelled)) Alert.alert('그림 모델 받기 실패', String(e?.message ?? e));
    } finally {
      deactivateKeepAwake('sd-download');
      abortRef.current = null;
    }
  }, []);

  const cancelDownload = useCallback(() => abortRef.current?.abort(), []);

  const remove = useCallback(() => {
    deleteImageModel();
    refresh();
  }, [refresh]);

  /** 그리기 직전에 호출: 준비됐으면 true, 아니면 안내(받기 제안) 후 false */
  const ensureReady = useCallback((): boolean => {
    if (status.kind === 'ready' || status.kind === 'unsupported') return true;
    if (status.kind === 'downloading') {
      Alert.alert('받는 중', '그림 모델을 받고 있습니다. 끝나면 다시 시도해 주세요.');
      return false;
    }
    Alert.alert(
      '그림 모델 필요',
      '수채화 동화풍 그림을 그리려면 그림 모델(약 1.6GB)을 한 번 받아야 합니다. 압축을 풀 때 약 3.3GB 의 여유 공간이 필요합니다. Wi-Fi 에서 받는 것을 권장합니다. 받을까요?',
      [
        { text: '취소', style: 'cancel' },
        { text: '받기', onPress: () => download() },
      ],
    );
    return false;
  }, [status, download]);

  return { status, download, cancelDownload, remove, ensureReady };
}

export function describeImageModel(s: ImageModelStatus): string {
  switch (s.kind) {
    case 'unsupported':
      return '이 기기에서는 도형 일러스트로 그립니다';
    case 'missing':
      return '그림 모델 없음 (약 1.6GB)';
    case 'ready':
      return '사용 가능 (수채화 동화풍)';
    case 'downloading':
      return `받는 중 ${Math.round((s.progress?.ratio ?? 0) * 100)}%${s.progress?.detail ? ` · ${s.progress.detail}` : ''}`;
  }
}

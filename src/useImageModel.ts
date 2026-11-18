/** 그림 모델(Stable Diffusion, iOS) 설치 상태: 확인 · 받기 · 지우기 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Network from 'expo-network';
import {
  checkImageModelUpdate,
  deleteImageModel,
  downloadImageModel,
  fetchSdManifest,
  findInstalledImageModel,
  isImageGenAvailable,
  trimImageModel,
  type ImageModelUpdate,
} from './imageGen';
import { DownloadCancelled } from './modelDownload';
import type { ImportProgress } from './modelStore';

export type ImageModelStatus =
  | { kind: 'unsupported' } // Android 등: 이미지 생성 모듈 없음 → 도형 일러스트로 대신
  | { kind: 'missing'; size?: number } // size: Release(sd.json)에서 읽은 받을 용량(바이트)
  | { kind: 'ready'; path: string }
  | { kind: 'downloading'; progress: ImportProgress | null };

/** onDownloaded: 다 받은 직후 호출 (그림 모델 미리 준비 등) */
export function useImageModel(onDownloaded?: (path: string) => void) {
  const [status, setStatus] = useState<ImageModelStatus>(() => {
    if (!isImageGenAvailable()) return { kind: 'unsupported' };
    const p = findInstalledImageModel();
    return p ? { kind: 'ready', path: p } : { kind: 'missing' };
  });
  const abortRef = useRef<AbortController | null>(null);
  const onDownloadedRef = useRef(onDownloaded);
  onDownloadedRef.current = onDownloaded;

  const refresh = useCallback(() => {
    if (!isImageGenAvailable()) return setStatus({ kind: 'unsupported' });
    try {
      trimImageModel(); // 이미 설치된 모델에서도 안 쓰는 부분 정리
    } catch {}
    const p = findInstalledImageModel();
    setStatus(p ? { kind: 'ready', path: p } : { kind: 'missing' });
  }, []);
  useEffect(refresh, [refresh]);

  // 아직 없으면 받을 용량을 Release 에서 읽어 둔다 (모델이 바뀌어도 앱 수정 없이 맞는 용량이 보이도록)
  const missing = status.kind === 'missing' && status.size == null;
  useEffect(() => {
    if (!missing) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    fetchSdManifest(ac.signal)
      .then((m) => setStatus((s) => (s.kind === 'missing' ? { kind: 'missing', size: m.size } : s)))
      .catch(() => {})
      .finally(() => clearTimeout(timer));
    return () => ac.abort();
  }, [missing]);

  const download = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus({ kind: 'downloading', progress: null });
    await activateKeepAwakeAsync('sd-download');
    try {
      const path = await downloadImageModel((p) => setStatus({ kind: 'downloading', progress: p }), ac.signal);
      setStatus({ kind: 'ready', path });
      onDownloadedRef.current?.(path);
    } catch (e: any) {
      setStatus({ kind: 'missing' });
      if (!(e instanceof DownloadCancelled)) Alert.alert('그림 모델 받기 실패', String(e?.message ?? e));
    } finally {
      deactivateKeepAwake('sd-download');
      abortRef.current = null;
    }
  }, []);

  const cancelDownload = useCallback(() => abortRef.current?.abort(), []);

  // 예전 그림 모델이 깔려 있으면 Wi-Fi 에서 앱을 열 때 새 모델로 자동 교체한다 (설정의 교체 버튼을 누르지 않아도 됨)
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current || !isImageGenAvailable() || !findInstalledImageModel()) return;
    autoChecked.current = true;
    const timer = setTimeout(async () => {
      const net = await Network.getNetworkStateAsync().catch(() => null);
      const unmetered = net?.type === Network.NetworkStateType.WIFI || net?.type === Network.NetworkStateType.ETHERNET;
      if (!unmetered || abortRef.current) return;
      const u = await checkImageModelUpdate();
      if (u && !abortRef.current) download(); // 예전 모델은 받기 시작할 때 지워진다
    }, 5_000); // 채팅 모델이 먼저 뜨도록 잠깐 기다린다
    return () => clearTimeout(timer);
  }, [download]);

  // 새 그림 모델이 나왔는지 (설정을 열 때 한 번 확인)
  const [update, setUpdate] = useState<ImageModelUpdate | null>(null);
  const updateChecked = useRef(false);
  const checkUpdate = useCallback(() => {
    if (updateChecked.current || !isImageGenAvailable()) return;
    updateChecked.current = true;
    checkImageModelUpdate().then(setUpdate);
  }, []);
  /** 지금 그림 모델을 지우고 새 모델을 받는다 (받은 뒤 onDownloaded 로 미리 준비) */
  const replace = useCallback(() => {
    if (!update) return;
    Alert.alert(
      '새 그림 모델로 교체',
      `${update.model}\n\n지금 그림 모델을 지우고 새 모델(${imageModelSizeText(update.size)})을 받습니다. ` +
        '압축을 풀 때 그만큼의 여유 공간이 더 필요합니다. Wi-Fi 권장.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '교체',
          onPress: () => {
            deleteImageModel();
            setUpdate(null);
            download();
          },
        },
      ],
    );
  }, [update, download]);

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
      `그림을 그리려면 그림 모델(${imageModelSizeText(status.size)})을 한 번 받아야 합니다. 압축을 풀 때 그 두 배쯤 여유 공간이 필요합니다. Wi-Fi 에서 받는 것을 권장합니다. 받을까요?`,
      [
        { text: '취소', style: 'cancel' },
        { text: '받기', onPress: () => download() },
      ],
    );
    return false;
  }, [status, download]);

  return { status, download, cancelDownload, remove, ensureReady, update, checkUpdate, replace };
}

/** 그림 모델 용량 글 (모르면 대략값) */
export function imageModelSizeText(size?: number): string {
  return size ? `약 ${(size / 1024 ** 3).toFixed(1)}GB` : '약 1~2.5GB';
}

export function describeImageModel(s: ImageModelStatus): string {
  switch (s.kind) {
    case 'unsupported':
      return '이 기기에서는 도형 일러스트로 그립니다';
    case 'missing':
      return `그림 모델 없음 (${imageModelSizeText(s.size)})`;
    case 'ready':
      return '사용 가능';
    case 'downloading':
      return `받는 중 ${Math.round((s.progress?.ratio ?? 0) * 100)}%${s.progress?.detail ? ` · ${s.progress.detail}` : ''}`;
  }
}

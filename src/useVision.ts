/**
 * 이미지 인식 상태 관리: 파일 유무 확인 → (설정이 켜져 있으면) 모델에 붙이기 / 받기 / 끄기.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { disableVision, enableVision, isVisionReady, type Settings } from './llm';
import { DownloadCancelled } from './modelDownload';
import type { ImportProgress } from './modelStore';
import { deleteVision, downloadVision, findInstalledVision } from './vision';

export type VisionStatus =
  | { kind: 'checking' }
  | { kind: 'missing' } // 파일 없음 → 받아야 함
  | { kind: 'off' } // 파일은 있지만 설정에서 끔
  | { kind: 'loading' } // 모델에 붙이는 중
  | { kind: 'ready' }
  | { kind: 'downloading'; progress: ImportProgress | null }
  | { kind: 'error'; message: string };

export function useVision(settings: Settings) {
  const [status, setStatus] = useState<VisionStatus>({ kind: 'checking' });
  const abortRef = useRef<AbortController | null>(null);

  const attach = useCallback(async () => {
    const v = findInstalledVision();
    if (!v) return setStatus({ kind: 'missing' });
    if (!settings.vision) {
      await disableVision().catch(() => {});
      return setStatus({ kind: 'off' });
    }
    if (isVisionReady()) return setStatus({ kind: 'ready' });
    setStatus({ kind: 'loading' });
    try {
      await enableVision(v.path, settings.useGpu);
      setStatus({ kind: 'ready' });
    } catch (e: any) {
      setStatus({ kind: 'error', message: String(e?.message ?? e) });
    }
  }, [settings.vision, settings.useGpu]);

  useEffect(() => {
    attach();
  }, [attach]);

  const download = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus({ kind: 'downloading', progress: null });
    await activateKeepAwakeAsync('vision');
    try {
      await downloadVision((p) => setStatus({ kind: 'downloading', progress: p }), ac.signal);
      await attach();
    } catch (e: any) {
      if (e instanceof DownloadCancelled) setStatus({ kind: 'missing' });
      else {
        setStatus({ kind: 'missing' });
        Alert.alert('이미지 인식 파일 받기 실패', String(e?.message ?? e));
      }
    } finally {
      deactivateKeepAwake('vision');
      abortRef.current = null;
    }
  }, [attach]);

  const cancelDownload = useCallback(() => abortRef.current?.abort(), []);

  const remove = useCallback(async () => {
    await disableVision().catch(() => {});
    deleteVision();
    setStatus({ kind: 'missing' });
  }, []);

  /**
   * 사진 기능을 쓰기 직전에 호출. 준비되어 있으면 true.
   * 파일이 없으면 받을지 묻고, 꺼져 있으면 안내한다.
   */
  const ensureReady = useCallback((): boolean => {
    switch (status.kind) {
      case 'ready':
        return true;
      case 'missing':
        Alert.alert(
          '이미지 인식 파일 필요',
          '사진을 이해하려면 이미지 인식 파일(약 0.85GB)을 한 번 받아야 합니다. Wi-Fi 에서 받는 것을 권장합니다. 받을까요?',
          [
            { text: '취소', style: 'cancel' },
            { text: '받기', onPress: () => download() },
          ],
        );
        return false;
      case 'off':
        Alert.alert('이미지 인식 꺼짐', '설정에서 "이미지 인식"을 켜면 사진을 쓸 수 있습니다.');
        return false;
      case 'downloading':
        Alert.alert('받는 중', '이미지 인식 파일을 받고 있습니다. 끝나면 다시 시도해 주세요.');
        return false;
      case 'loading':
      case 'checking':
        Alert.alert('준비 중', '이미지 인식을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.');
        return false;
      case 'error':
        Alert.alert(
          '이미지 인식 오류',
          `${status.message}\n\n메모리가 부족하면 설정에서 GPU 를 끄거나 컨텍스트 길이를 줄여 보세요.`,
          [
            { text: '닫기', style: 'cancel' },
            { text: '다시 시도', onPress: () => attach() },
          ],
        );
        return false;
    }
  }, [status, download, attach]);

  return { status, download, cancelDownload, remove, ensureReady, retry: attach };
}

export function describeVision(s: VisionStatus): string {
  switch (s.kind) {
    case 'checking':
      return '확인 중';
    case 'missing':
      return '이미지 인식 파일 없음 (약 0.85GB)';
    case 'off':
      return '꺼짐';
    case 'loading':
      return '불러오는 중…';
    case 'ready':
      return '사용 가능';
    case 'downloading':
      return `받는 중 ${Math.round((s.progress?.ratio ?? 0) * 100)}%`;
    case 'error':
      return `오류: ${s.message}`;
  }
}

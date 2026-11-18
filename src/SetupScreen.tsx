import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Network from 'expo-network';
import type { File } from 'expo-file-system';
import {
  cleanupPickedCopies,
  formatBytes,
  installFromFiles,
  listInboxFiles,
  pickModelFiles,
  type ImportProgress,
  type InstalledModel,
} from './modelStore';
import { DownloadCancelled, downloadModel, fetchManifest, formatDownloadEta, hasPartialDownload } from './modelDownload';
import { downloadVision, fetchVisionManifest, findInstalledVision } from './vision';
import {
  downloadImageModel,
  fetchSdManifest,
  findInstalledImageModel,
  isImageGenAvailable,
  prepareImageModel,
} from './imageGen';
import { SetupPreview } from './SetupPreview';
import { colors } from './theme';

/**
 * 처음 설치 때 한 번에 받는 것: 채팅 모델 + 사진 인식(비전) + 그림 모델(iPhone 만).
 * 글자 읽기(OCR)는 기기 내장 기능이라 따로 받을 것이 없다.
 */
const WITH_IMAGE_MODEL = isImageGenAvailable();
const STEPS = WITH_IMAGE_MODEL ? 3 : 2;
const FALLBACK_SIZE = WITH_IMAGE_MODEL ? '약 5GB' : '약 3.2GB';

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)}GB`;

/** Release 의 manifest 들을 읽어 실제 받을 용량을 글로 만든다 (못 읽으면 대략값) */
async function fetchSizeText(): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const [chat, vision, sd] = await Promise.allSettled([
      fetchManifest(ac.signal),
      fetchVisionManifest(ac.signal),
      WITH_IMAGE_MODEL ? fetchSdManifest(ac.signal) : Promise.reject(new Error('n/a')),
    ]);
    if (chat.status !== 'fulfilled') return null;
    const parts = [['채팅', chat.value.size]] as [string, number][];
    if (vision.status === 'fulfilled') parts.push(['사진 인식', vision.value.size]);
    if (sd.status === 'fulfilled') parts.push(['그림', sd.value.size]);
    const total = parts.reduce((a, [, n]) => a + n, 0);
    return parts.length === 1 ? `약 ${gb(total)}` : `약 ${gb(total)}: ${parts.map(([k, n]) => `${k} ${gb(n)}`).join(' + ')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const STAGE_LABEL: Record<ImportProgress['stage'], string> = {
  checking: '확인 중',
  downloading: '모델 다운로드 중',
  joining: '조각 이어 붙이는 중',
  copying: '모델 복사 중',
  unzipping: '압축 해제 중',
  verifying: '모델 파일 확인 중',
  preparing: '그림 모델 준비 중',
  done: '완료',
};

type SetupProgress = ImportProgress & { downloadStep?: string };

type Busy = null | 'download' | 'import';

export function SetupScreen({ onInstalled }: { onInstalled: (m: InstalledModel, initialInput: string) => void }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [inbox, setInbox] = useState<File[]>([]);
  const [showManual, setShowManual] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [sizeText, setSizeText] = useState(FALLBACK_SIZE);
  const abortRef = useRef<AbortController | null>(null);
  const autoStarted = useRef(false);
  const initialInput = useRef('');
  const choosePrompt = useCallback((prompt: string) => {
    initialInput.current = prompt;
  }, []);

  useEffect(() => {
    fetchSizeText().then((t) => t && setSizeText(t));
  }, []);

  const refreshInbox = useCallback(() => {
    if (Platform.OS === 'ios') setInbox(listInboxFiles());
  }, []);
  useEffect(refreshInbox, [refreshInbox]);

  const startDownload = useCallback(async () => {
    if (abortRef.current) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy('download');
    setLastError(null);
    try {
      await activateKeepAwakeAsync('download');
      const step = (n: number, what: string) => (p: ImportProgress) =>
        setProgress({ ...p, downloadStep: `${n}/${STEPS} ${what}` });
      const m = await downloadModel(step(1, '채팅 모델'), ac.signal);

      // 사진 인식·그림 모델도 이어서 받는다. 실패해도 채팅은 바로 시작하고, 나머지는 쓸 때 다시 받는다
      const failed: string[] = [];
      if (!ac.signal.aborted && !findInstalledVision()) {
        try {
          await downloadVision(step(2, '사진 인식'), ac.signal);
        } catch (e: any) {
          if (!(e instanceof DownloadCancelled) && !ac.signal.aborted) failed.push(`사진 인식: ${e?.message ?? e}`);
        }
      }
      if (WITH_IMAGE_MODEL && !ac.signal.aborted && !findInstalledImageModel()) {
        try {
          await downloadImageModel(step(3, '그림 모델'), ac.signal);
          step(3, '그림 모델')({ stage: 'preparing', ratio: 1, detail: '이 기기에서 한 번만 준비합니다. 약 1~3분 걸려요.' });
          await prepareImageModel();
        } catch (e: any) {
          if (!(e instanceof DownloadCancelled) && !ac.signal.aborted) failed.push(`그림 모델: ${e?.message ?? e}`);
        }
      }
      if (failed.length) {
        Alert.alert('일부는 나중에 받을 수 있어요', `채팅은 바로 시작합니다. 아래 항목은 처음 쓸 때 다시 받습니다.\n\n${failed.join('\n\n')}`);
      }
      onInstalled(m, initialInput.current);
    } catch (e: any) {
      if (!(e instanceof DownloadCancelled)) {
        const msg = String(e?.message ?? e);
        setLastError(msg);
        Alert.alert('다운로드 실패', msg);
      }
    } finally {
      deactivateKeepAwake('download');
      abortRef.current = null;
      setBusy(null);
      setProgress(null);
    }
  }, [onInstalled]);

  /** 셀룰러면 데이터 사용 확인 후 시작 */
  const onDownloadPress = async () => {
    const net = await Network.getNetworkStateAsync().catch(() => null);
    if (net?.type === Network.NetworkStateType.CELLULAR) {
      Alert.alert('모바일 데이터 사용', `${sizeText}를 모바일 데이터로 받습니다. 계속할까요? (Wi-Fi 권장)`, [
        { text: '취소', style: 'cancel' },
        { text: '받기', onPress: () => startDownload() },
      ]);
      return;
    }
    if (net && net.isConnected === false) {
      Alert.alert('인터넷 연결 없음', 'Wi-Fi에 연결한 뒤 다시 시도하세요. 또는 아래 "파일로 직접 설치"를 이용하세요.');
      return;
    }
    startDownload();
  };

  // 앱을 처음 열었을 때 Wi-Fi 면 자동으로 받기 시작 (받다 만 것도 자동으로 이어받기)
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    (async () => {
      const net = await Network.getNetworkStateAsync().catch(() => null);
      const onWifi = net?.type === Network.NetworkStateType.WIFI && net.isInternetReachable !== false;
      const onEthernet = net?.type === Network.NetworkStateType.ETHERNET;
      if (onWifi || onEthernet) startDownload();
      else if (hasPartialDownload()) setLastError('받다 만 모델이 있습니다. Wi-Fi에 연결하면 이어서 받습니다.');
    })();
  }, [startDownload]);

  const runImport = async (files: File[], consumeSources: boolean) => {
    setBusy('import');
    await activateKeepAwakeAsync('import'); // 수 GB 작업 중 화면 꺼짐 방지
    try {
      const m = await installFromFiles(files, setProgress, { consumeSources });
      onInstalled(m, initialInput.current);
    } catch (e: any) {
      Alert.alert('모델 설치 실패', String(e?.message ?? e));
    } finally {
      deactivateKeepAwake('import');
      setBusy(null);
      setProgress(null);
      refreshInbox();
    }
  };

  const onPick = async () => {
    let files: File[] | null = null;
    try {
      files = await pickModelFiles();
      if (files?.length) await runImport(files, false);
    } catch (e: any) {
      Alert.alert('파일 선택 실패', String(e?.message ?? e));
    } finally {
      if (files) cleanupPickedCopies(files);
    }
  };

  const pct = Math.floor(Math.min(1, Math.max(0, progress?.ratio ?? 0)) * 100);
  const transfer = progress?.transfer;
  const determinate = progress?.stage === 'downloading' || progress?.stage === 'joining' || progress?.stage === 'unzipping';
  const canCancel = busy === 'download' && progress?.stage !== 'verifying'
    && progress?.stage !== 'preparing' && progress?.stage !== 'done';

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.mark} accessible={false}>
        <Text style={styles.glyph}>✦</Text>
      </View>
      <Text style={styles.title}>Gemma Chat</Text>
      <Text style={styles.sub}>
        처음 한 번만 채팅·사진 인식{WITH_IMAGE_MODEL ? '·그림' : ''} 모델({sizeText})을 내려받습니다. 그 뒤 대화, 사진·글자 인식{WITH_IMAGE_MODEL ? ', 그림' : ''}은 인터넷 없이 이 기기 안에서만 처리됩니다.
      </Text>

      {busy ? (
        <View style={styles.card}>
          {progress?.downloadStep ? <Text style={styles.muted}>{progress.downloadStep}</Text> : null}
          <View style={styles.progressHeading}>
            <Text accessibilityRole="header" style={styles.progressTitle}>
              {progress ? STAGE_LABEL[progress.stage] : '준비 중'}
            </Text>
            {determinate ? (
              <Text style={styles.percent} accessible={false}>{pct}%</Text>
            ) : (
              <ActivityIndicator color={colors.accent} />
            )}
          </View>
          {determinate ? (
            <View
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel={STAGE_LABEL[progress.stage]}
              accessibilityValue={{ min: 0, now: pct, max: 100 }}
              style={styles.bar}
            >
              <View style={[styles.barFill, { width: `${pct}%` }]} />
            </View>
          ) : null}
          {transfer ? (
            <View style={styles.transfer}>
              <Text style={styles.muted}>{formatBytes(transfer.received)} / {formatBytes(transfer.total)}</Text>
              {transfer.secondsLeft !== undefined || (!progress.detail && transfer.received < transfer.total) ? (
                <Text style={styles.eta}>
                  {transfer.secondsLeft === undefined ? '남은 시간 계산 중' : formatDownloadEta(transfer.secondsLeft)}
                </Text>
              ) : null}
            </View>
          ) : null}
          {progress?.detail ? <Text style={styles.muted}>{progress.detail}</Text> : null}
          {canCancel ? (
            <>
              <Text style={styles.muted}>앱을 나가면 다운로드가 멈춰요. 돌아오면 이어서 받을 수 있습니다.</Text>
              <Pressable accessibilityRole="button" style={styles.link} onPress={() => abortRef.current?.abort()}>
                <Text style={[styles.linkText, { color: colors.danger }]}>다운로드 중단</Text>
              </Pressable>
            </>
          ) : busy === 'import' ? (
            <Text style={styles.muted}>앱을 닫지 마세요. 수 분 걸릴 수 있습니다.</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.h}>Gemma 3 4B{WITH_IMAGE_MODEL ? ' + 그림' : ''} 모델 다운로드</Text>
          <Text style={styles.p}>
            GitHub 저장소(JordonPark/gemma-chat)의 Release 에서 조각을 받아 기기 안에서 이어 붙이고 SHA-256 으로
            검증합니다. Wi-Fi 에서는 앱을 열면 자동으로 시작합니다.
          </Text>
          {lastError ? <Text style={[styles.muted, { color: colors.danger }]}>{lastError}</Text> : null}
          <Pressable style={styles.btn} onPress={onDownloadPress}>
            <Text style={styles.btnText}>{hasPartialDownload() ? '이어서 받기' : `모델 다운로드 (${sizeText})`}</Text>
          </Pressable>
        </View>
      )}

      <SetupPreview onChoosePrompt={choosePrompt} />

      <Pressable style={styles.link} onPress={() => setShowManual((v) => !v)} disabled={!!busy}>
        <Text style={styles.linkText}>{showManual ? '▾' : '▸'} 인터넷 없이 파일로 직접 설치</Text>
      </Pressable>

      {showManual && (
        <>
          <View style={styles.card}>
            <Text style={styles.p}>
              PC에서 tools/pack_model.sh 로 만든 파일(…gguf.part00, part01, SHA256SUMS)을 기기로 옮긴 뒤 전부 함께
              선택하세요. 앱이 이어 붙이고 검증해서 설치합니다. 단일 .gguf 나 .zip 도 됩니다.
            </Text>
            <Pressable style={[styles.btn, !!busy && styles.btnOff]} disabled={!!busy} onPress={onPick}>
              <Text style={styles.btnText}>모델 파일 선택 (여러 개 선택 가능)</Text>
            </Pressable>
          </View>

          {Platform.OS === 'ios' && (
            <View style={styles.card}>
              <Text style={styles.h}>Finder / iTunes / 파일 앱으로 넣기</Text>
              <Text style={styles.p}>
                PC: iTunes(또는 Apple Devices) › iPhone › 파일 공유 › Gemma Chat 에 드래그. Mac: Finder › iPhone ›
                파일 › Gemma Chat. 또는 파일 앱 › 나의 iPhone › Gemma Chat 폴더에 복사.
              </Text>
              {inbox.length > 0 ? (
                <>
                  {inbox.map((f) => (
                    <Text key={f.uri} style={styles.file}>
                      • {f.name} ({formatBytes(f.size ?? 0)})
                    </Text>
                  ))}
                  <Pressable
                    style={[styles.btn, !!busy && styles.btnOff]}
                    disabled={!!busy}
                    onPress={() => runImport(inbox, true)}
                  >
                    <Text style={styles.btnText}>이 파일들로 설치</Text>
                  </Pressable>
                </>
              ) : (
                <Text style={styles.muted}>폴더에 파일이 없습니다.</Text>
              )}
              <Pressable style={styles.link} onPress={refreshInbox} disabled={!!busy}>
                <Text style={styles.linkText}>새로고침</Text>
              </Pressable>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingVertical: 32, gap: 16, width: '100%', maxWidth: 600, alignSelf: 'center' },
  mark: { width: 62, height: 62, borderRadius: 21, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 35, color: colors.accentText },
  title: { fontSize: 34, fontWeight: '800', letterSpacing: -0.8, color: colors.text },
  sub: { fontSize: 15, lineHeight: 23, color: colors.muted, marginBottom: 8 },
  card: { backgroundColor: colors.card, borderRadius: 22, borderWidth: 1, borderColor: colors.border, padding: 18, gap: 12 },
  h: { fontSize: 17, fontWeight: '700', color: colors.text },
  p: { fontSize: 14, lineHeight: 20, color: colors.text },
  muted: { fontSize: 13, color: colors.muted },
  file: { fontSize: 13, color: colors.text, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  btn: { backgroundColor: colors.accent, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  btnOff: { opacity: 0.5 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  link: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  linkText: { color: colors.accentText, fontSize: 14 },
  progressHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  progressTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '800' },
  percent: { color: colors.accentText, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  transfer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6 },
  eta: { color: colors.accentText, fontSize: 14, fontWeight: '700' },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  barFill: { height: 8, backgroundColor: colors.accent },
});

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
import { DownloadCancelled, downloadModel, hasPartialDownload } from './modelDownload';
import { colors } from './theme';

const STAGE_LABEL: Record<ImportProgress['stage'], string> = {
  checking: '확인 중',
  downloading: '모델 다운로드 중',
  joining: '조각 이어 붙이는 중',
  copying: '모델 복사 중',
  unzipping: '압축 해제 중',
  verifying: '무결성(SHA-256) 검사 중',
  done: '완료',
};

type Busy = null | 'download' | 'import';

export function SetupScreen({ onInstalled }: { onInstalled: (m: InstalledModel) => void }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [inbox, setInbox] = useState<File[]>([]);
  const [showManual, setShowManual] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoStarted = useRef(false);

  const refreshInbox = useCallback(() => {
    if (Platform.OS === 'ios') setInbox(listInboxFiles());
  }, []);
  useEffect(refreshInbox, [refreshInbox]);

  const startDownload = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy('download');
    setLastError(null);
    await activateKeepAwakeAsync('download'); // 다운로드 중 화면 꺼짐(→ 앱 일시정지) 방지
    try {
      const m = await downloadModel(setProgress, ac.signal);
      onInstalled(m);
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
      Alert.alert('모바일 데이터 사용', '약 2.4GB를 모바일 데이터로 받습니다. 계속할까요? (Wi-Fi 권장)', [
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
      onInstalled(m);
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

  const pct = Math.round((progress?.ratio ?? 0) * 100);

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.mark} accessible={false}>
        <Text style={styles.glyph}>✦</Text>
      </View>
      <Text style={styles.title}>Gemma Chat</Text>
      <Text style={styles.sub}>
        처음 한 번만 모델(약 2.4GB)을 내려받습니다. 그 뒤 대화는 인터넷 없이 이 기기 안에서만 처리됩니다.
      </Text>

      {busy ? (
        <View style={styles.card}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.p}>
            {progress ? STAGE_LABEL[progress.stage] : '준비 중'} {progress ? `${pct}%` : ''}
          </Text>
          {progress?.detail ? <Text style={styles.muted}>{progress.detail}</Text> : null}
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${pct}%` }]} />
          </View>
          <Text style={styles.muted}>
            {busy === 'download'
              ? '앱을 켜 둔 채로 기다려 주세요. 앱을 나가면 다운로드가 멈추고, 다시 열면 이어서 받습니다.'
              : '앱을 닫지 마세요. 수 분 걸릴 수 있습니다.'}
          </Text>
          {busy === 'download' && (
            <Pressable style={styles.link} onPress={() => abortRef.current?.abort()}>
              <Text style={[styles.linkText, { color: colors.danger }]}>다운로드 취소</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.h}>Gemma 3 4B 모델 다운로드</Text>
          <Text style={styles.p}>
            GitHub 저장소(JordonPark/gemma-chat)의 Release 에서 조각을 받아 기기 안에서 이어 붙이고 SHA-256 으로
            검증합니다. Wi-Fi 에서는 앱을 열면 자동으로 시작합니다.
          </Text>
          {lastError ? <Text style={[styles.muted, { color: colors.danger }]}>{lastError}</Text> : null}
          <Pressable style={styles.btn} onPress={onDownloadPress}>
            <Text style={styles.btnText}>{hasPartialDownload() ? '이어서 받기' : '모델 다운로드 (약 2.4GB)'}</Text>
          </Pressable>
        </View>
      )}

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
  link: { alignSelf: 'flex-start', paddingVertical: 4 },
  linkText: { color: colors.accentText, fontSize: 14 },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: colors.accent },
});

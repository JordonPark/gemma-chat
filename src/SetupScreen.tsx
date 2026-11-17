import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
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
import { colors } from './theme';

const STAGE_LABEL: Record<ImportProgress['stage'], string> = {
  checking: '파일 확인 중',
  joining: '분할 조각 이어 붙이는 중',
  copying: '모델 복사 중',
  unzipping: '압축 해제 중',
  verifying: '무결성(SHA-256) 검사 중',
  done: '완료',
};

export function SetupScreen({ onInstalled }: { onInstalled: (m: InstalledModel) => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [inbox, setInbox] = useState<File[]>([]);

  const refreshInbox = useCallback(() => {
    if (Platform.OS === 'ios') setInbox(listInboxFiles());
  }, []);
  useEffect(refreshInbox, [refreshInbox]);

  const run = async (files: File[], consumeSources: boolean) => {
    setBusy(true);
    await activateKeepAwakeAsync('import'); // 수 GB 작업 중 화면 꺼짐 방지
    try {
      const m = await installFromFiles(files, setProgress, { consumeSources });
      onInstalled(m);
    } catch (e: any) {
      Alert.alert('모델 설치 실패', String(e?.message ?? e));
    } finally {
      deactivateKeepAwake('import');
      setBusy(false);
      setProgress(null);
      refreshInbox();
    }
  };

  const onPick = async () => {
    let files: File[] | null = null;
    try {
      files = await pickModelFiles();
      if (files?.length) await run(files, false);
    } catch (e: any) {
      Alert.alert('파일 선택 실패', String(e?.message ?? e));
    } finally {
      if (files) cleanupPickedCopies(files);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>Gemma 3 4B 오프라인 챗봇</Text>
      <Text style={styles.sub}>이 앱은 네트워크를 사용하지 않습니다. 모델 파일을 기기에 넣어 주세요.</Text>

      <View style={styles.card}>
        <Text style={styles.h}>1. PC에서 git으로 모델 받기</Text>
        <Text style={styles.p}>
          저장소의 tools/pack_model.sh 로 받은 파일(gemma-3-4b-it-q4_0.gguf.part00, part01 … 와 SHA256SUMS)을
          USB·AirDrop·파일 앱 등으로 기기에 복사합니다.
        </Text>
        <Text style={styles.h}>2. 기기에서 풀기</Text>
        <Text style={styles.p}>
          아래 버튼으로 조각 전부와 SHA256SUMS 를 함께 선택하면, 앱이 기기 안에서 이어 붙이고(zip이면 압축 해제)
          검증한 뒤 설치합니다. 단일 .gguf 나 .zip 도 됩니다.
        </Text>
      </View>

      <Pressable style={[styles.btn, busy && styles.btnOff]} disabled={busy} onPress={onPick}>
        <Text style={styles.btnText}>모델 파일 선택 (여러 개 선택 가능)</Text>
      </Pressable>

      {Platform.OS === 'ios' && (
        <View style={styles.card}>
          <Text style={styles.h}>또는: Finder / 파일 앱으로 넣기</Text>
          <Text style={styles.p}>
            Mac Finder에서 iPhone 선택 → 파일 → Gemma Chat 에 드래그하거나, 파일 앱 › 나의 iPhone › Gemma Chat
            폴더에 복사하세요. (복사본을 바로 옮겨 쓰므로 공간을 덜 씁니다)
          </Text>
          {inbox.length > 0 ? (
            <>
              {inbox.map((f) => (
                <Text key={f.uri} style={styles.file}>
                  • {f.name} ({formatBytes(f.size ?? 0)})
                </Text>
              ))}
              <Pressable style={[styles.btn, busy && styles.btnOff]} disabled={busy} onPress={() => run(inbox, true)}>
                <Text style={styles.btnText}>이 파일들로 설치</Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.muted}>폴더에 파일이 없습니다.</Text>
          )}
          <Pressable style={styles.link} onPress={refreshInbox} disabled={busy}>
            <Text style={styles.linkText}>새로고침</Text>
          </Pressable>
        </View>
      )}

      {busy && (
        <View style={styles.card}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.p}>
            {progress ? STAGE_LABEL[progress.stage] : '준비 중'}{' '}
            {progress && progress.stage !== 'verifying' ? `${Math.round(progress.ratio * 100)}%` : ''}
          </Text>
          {progress?.detail ? <Text style={styles.muted}>{progress.detail}</Text> : null}
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }]} />
          </View>
          <Text style={styles.muted}>앱을 닫지 마세요. 수 분 걸릴 수 있습니다.</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 20, gap: 14 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  sub: { fontSize: 14, color: colors.muted },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, gap: 8 },
  h: { fontSize: 15, fontWeight: '600', color: colors.text },
  p: { fontSize: 14, lineHeight: 20, color: colors.text },
  muted: { fontSize: 13, color: colors.muted },
  file: { fontSize: 13, color: colors.text, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  btn: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  btnOff: { opacity: 0.5 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  link: { alignSelf: 'flex-start', paddingVertical: 4 },
  linkText: { color: colors.accent, fontSize: 14 },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: colors.accent },
});

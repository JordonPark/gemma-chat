/**
 * OTA 업데이트(expo-updates) 안내.
 * - 앱이 Wi-Fi 에서 켜질 때 새 JS 업데이트를 받아 둔다(app.config.ts 의 checkAutomatically: WIFI_ONLY).
 * - 받아 둔 업데이트가 있으면 화면 위에 "다시 시작" 배너를 띄운다. 누르지 않아도 다음 실행 때 적용된다.
 */
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import { colors } from './theme';

export function UpdateBanner({ busy }: { busy: boolean }) {
  const { isUpdatePending } = Updates.useUpdates();
  if (!Updates.isEnabled || !isUpdatePending) return null;
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>새 버전이 준비되었습니다.</Text>
      <Pressable
        disabled={busy}
        onPress={() => Updates.reloadAsync().catch((e) => Alert.alert('다시 시작 실패', String(e?.message ?? e)))}
        style={[styles.btn, busy && { opacity: 0.4 }]}
      >
        <Text style={styles.btnText}>다시 시작</Text>
      </Pressable>
    </View>
  );
}

export function describeAppVersion(): string {
  if (!Updates.isEnabled) return 'OTA 업데이트 꺼짐 (내장 버전)';
  const when = Updates.createdAt ? Updates.createdAt.toLocaleString() : '';
  const ch = Updates.channel ? ` · 채널 ${Updates.channel}` : '';
  return Updates.isEmbeddedLaunch
    ? `내장 버전 · 런타임 ${Updates.runtimeVersion ?? '-'}${ch}`
    : `OTA 업데이트 ${Updates.updateId?.slice(0, 8) ?? ''} · ${when}${ch}`;
}

/** 설정 화면의 "업데이트 확인" 버튼 */
export async function checkForUpdateInteractive() {
  if (!Updates.isEnabled) {
    Alert.alert('업데이트', '이 빌드는 OTA 업데이트가 꺼져 있습니다.');
    return;
  }
  try {
    const r = await Updates.checkForUpdateAsync();
    if (!r.isAvailable) {
      Alert.alert('업데이트', '최신 버전입니다.');
      return;
    }
    await Updates.fetchUpdateAsync();
    Alert.alert('업데이트', '새 버전을 받았습니다. 지금 다시 시작할까요?', [
      { text: '나중에', style: 'cancel' },
      { text: '다시 시작', onPress: () => Updates.reloadAsync() },
    ]);
  } catch (e: any) {
    Alert.alert('업데이트 확인 실패', `인터넷 연결을 확인하세요.\n(${e?.message ?? e})`);
  }
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  text: { flex: 1, color: colors.text, fontSize: 14 },
  btn: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  btnText: { color: '#fff', fontWeight: '600' },
});

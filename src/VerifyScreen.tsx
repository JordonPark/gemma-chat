/**
 * 사진 인증: 조건(물체·글자)을 정하고 카메라로 찍거나 앨범에서 고르면,
 * Gemma 가 기기 안에서 사진을 보고 통과 / 실패 / 판단 어려움 을 판정한다.
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { verifyImage, type VerifyResult } from './llm';
import { colors, isDark } from './theme';
import { pickImage, type ImageSource } from './vision';

const EXAMPLES = ['텀블러가 보여야 함', "'영수증' 글자가 있어야 함", '사람이 운동하는 모습', '책 표지에 제목이 보임'];

const VERDICT = {
  PASS: { icon: '✅', label: '인증 성공', color: '#2e7d32', bg: isDark ? '#16301a' : '#e8f5e9' },
  FAIL: { icon: '❌', label: '인증 실패', color: '#c62828', bg: isDark ? '#3a1a1a' : '#ffebee' },
  UNSURE: { icon: '⚠️', label: '판단 어려움', color: '#b26a00', bg: isDark ? '#3a2c12' : '#fff8e1' },
} as const;

type Props = {
  visible: boolean;
  onClose: () => void;
  /** 이미지 인식이 준비됐는지 확인 (아니면 안내를 띄우고 false) */
  ensureVision: () => boolean;
  /** 채팅이 답을 만드는 중이면 true (동시에 돌릴 수 없음) */
  chatBusy: boolean;
};

export function VerifyScreen({ visible, onClose, ensureVision, chatBusy }: Props) {
  const insets = useSafeAreaInsets();
  const [condition, setCondition] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const run = async (source: ImageSource) => {
    if (!condition.trim()) {
      Alert.alert('인증 조건', '무엇을 확인할지 먼저 적어 주세요. 예: 텀블러가 보여야 함');
      return;
    }
    if (chatBusy) {
      Alert.alert('잠시만요', '채팅 답변을 만드는 중입니다. 끝난 뒤 다시 시도하세요.');
      return;
    }
    if (!ensureVision()) return;
    let uri: string | null = null;
    try {
      uri = await pickImage(source);
    } catch (e: any) {
      Alert.alert('사진', String(e?.message ?? e));
      return;
    }
    if (!uri) return;
    setImage(uri);
    setResult(null);
    setBusy(true);
    await activateKeepAwakeAsync('verify');
    try {
      setResult(await verifyImage(uri, condition));
    } catch (e: any) {
      Alert.alert('인증 실패', String(e?.message ?? e));
    } finally {
      deactivateKeepAwake('verify');
      setBusy(false);
    }
  };

  const v = result ? VERDICT[result.verdict] : null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.title}>사진 인증</Text>
          <Pressable onPress={onClose} disabled={busy} style={styles.close}>
            <Text style={styles.closeText}>닫기</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.label}>인증 조건</Text>
          <TextInput
            style={styles.input}
            value={condition}
            onChangeText={setCondition}
            placeholder="예: 텀블러가 보여야 함 / '영수증' 글자가 있어야 함"
            placeholderTextColor={colors.muted}
            editable={!busy}
            multiline
          />
          <View style={styles.chips}>
            {EXAMPLES.map((ex) => (
              <Pressable key={ex} style={styles.chip} onPress={() => setCondition(ex)} disabled={busy}>
                <Text style={styles.chipText}>{ex}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.row}>
            <Pressable style={[styles.btn, busy && styles.off]} disabled={busy} onPress={() => run('camera')}>
              <Text style={styles.btnText}>📷 카메라로 인증</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, styles.btnAlt, busy && styles.off]}
              disabled={busy}
              onPress={() => run('library')}
            >
              <Text style={[styles.btnText, { color: colors.text }]}>🖼 앨범에서</Text>
            </Pressable>
          </View>

          {image ? <Image source={{ uri: image }} style={styles.photo} resizeMode="contain" /> : null}

          {busy ? (
            <View style={styles.card}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.muted}>기기 안에서 사진을 확인하는 중… (10~40초)</Text>
            </View>
          ) : null}

          {result && v ? (
            <View style={[styles.card, { backgroundColor: v.bg, borderColor: v.color }]}>
              <Text style={[styles.verdict, { color: v.color }]}>
                {v.icon} {v.label}
              </Text>
              {result.reason ? <Text style={styles.text}>{result.reason}</Text> : null}
              {result.seen ? (
                <Text style={styles.meta}>
                  <Text style={styles.metaKey}>보이는 것 </Text>
                  {result.seen}
                </Text>
              ) : null}
              {result.text ? (
                <Text style={styles.meta}>
                  <Text style={styles.metaKey}>읽은 글자 </Text>
                  {result.text}
                </Text>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.note}>
            사진은 이 기기 밖으로 나가지 않습니다. 작은 글씨나 한글은 틀리게 읽을 수 있으니 중요한 인증은 사진을
            가까이, 밝게 찍어 주세요.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.text },
  close: { paddingHorizontal: 10, paddingVertical: 6 },
  closeText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  body: { padding: 16, gap: 12 },
  label: { fontSize: 14, fontWeight: '600', color: colors.text },
  input: {
    minHeight: 56,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    textAlignVertical: 'top',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipText: { color: colors.text, fontSize: 13 },
  row: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  btnAlt: { backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  off: { opacity: 0.4 },
  photo: { width: '100%', height: 280, borderRadius: 12, backgroundColor: colors.card },
  card: {
    gap: 8,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'stretch',
  },
  verdict: { fontSize: 20, fontWeight: '800' },
  text: { fontSize: 15, lineHeight: 22, color: colors.text },
  meta: { fontSize: 13, lineHeight: 19, color: colors.text },
  metaKey: { fontWeight: '700', color: colors.muted },
  muted: { fontSize: 13, color: colors.muted, textAlign: 'center' },
  note: { fontSize: 12, lineHeight: 18, color: colors.muted, marginTop: 4 },
});

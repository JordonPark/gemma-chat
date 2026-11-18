import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { ChatMessage } from './llm';
import { APP_VERSION, SUPPORT_BASE_URL } from './storeConfig';
import { colors } from './theme';

const reasons = [
  { id: 'sexual', title: '성적 콘텐츠 또는 착취' },
  { id: 'violence', title: '폭력 또는 위험한 행동' },
  { id: 'abuse', title: '혐오, 괴롭힘 또는 개인정보 침해' },
  { id: 'deception', title: '사기 또는 기만' },
  { id: 'other', title: '기타 부적절한 콘텐츠' },
];

export function ReportContent({ item, onClose }: { item: ChatMessage; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');

  const send = async () => {
    if (!reason || sending || receipt || !SUPPORT_BASE_URL) return;
    setSending(true);
    setError('');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      // 신고는 답변 텍스트만 보낸다 (개인정보처리방침과 일치)
      const type = 'text/plain';
      const content = item.content.slice(0, 24_000);
      const response = await fetch(`${SUPPORT_BASE_URL}/reports`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, type, content, platform: Platform.OS, appVersion: APP_VERSION }),
      });
      if (response.status !== 201) throw new Error('report rejected');
      const id = (await response.json())?.id;
      if (typeof id !== 'string') throw new Error('missing report receipt');
      setReceipt(id);
    } catch {
      setError('신고를 보내지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
    } finally {
      clearTimeout(timer);
      setSending(false);
    }
  };

  const close = () => {
    if (!sending) onClose();
  };

  return (
    <Modal presentationStyle="pageSheet" animationType="slide" onRequestClose={close}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.screen}>
          <ScrollView contentContainerStyle={styles.wrap}>
            {receipt ? (
              <>
                <Text style={styles.title} accessibilityRole="header">신고가 접수됐습니다</Text>
                <Text style={styles.body} selectable>접수번호 {receipt}</Text>
                <Text style={styles.body}>개인정보 문의에서 이 번호를 사용할 수 있습니다.</Text>
                <Pressable style={styles.submit} onPress={close} accessibilityRole="button">
                  <Text style={styles.submitText}>닫기</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.title} accessibilityRole="header">AI 결과 신고</Text>
                <Text style={styles.body}>선택한 AI 결과와 신고 사유가 검토를 위해 개발자에게 비공개로 전송됩니다.</Text>
                {reasons.map(({ id, title }) => (
                  <Pressable
                    key={id}
                    style={[styles.option, reason === id && styles.selected]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: reason === id }}
                    disabled={sending}
                    onPress={() => setReason(id)}
                  >
                    <Text style={styles.body}>{title}</Text>
                  </Pressable>
                ))}
                {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
                <View style={styles.buttons}>
                  <Pressable style={styles.option} onPress={close} accessibilityRole="button" disabled={sending}>
                    <Text style={styles.body}>취소</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.submit, (!reason || sending) && styles.disabled]}
                    onPress={send}
                    accessibilityRole="button"
                    disabled={!reason || sending}
                  >
                    <Text style={styles.submitText}>{sending ? '보내는 중…' : '신고 보내기'}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  wrap: { padding: 20, gap: 10, width: '100%', maxWidth: 520, alignSelf: 'center' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  body: { color: colors.text, fontSize: 15, lineHeight: 22 },
  option: { minHeight: 44, justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 10 },
  selected: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  error: { color: colors.danger, fontSize: 14 },
  buttons: { flexDirection: 'row', gap: 10 },
  submit: { minHeight: 44, flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.accent },
  submitText: { color: '#fff', fontWeight: '700' },
  disabled: { opacity: 0.45 },
});

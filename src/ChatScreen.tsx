import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  generateReply,
  resetConversationCache,
  stopGeneration,
  type ChatMessage,
  type GenStats,
  type Settings,
} from './llm';
import { formatBytes, type InstalledModel } from './modelStore';
import { Markdown } from './Markdown';
import { UpdateBanner, checkForUpdateInteractive, describeAppVersion } from './UpdateBanner';
import { loadChat, saveChat } from './storage';
import { colors } from './theme';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type Props = {
  model: InstalledModel;
  settings: Settings;
  gpuInfo: string;
  onChangeSettings: (s: Settings) => void;
  onRemoveModel: () => void;
};

export function ChatScreen({ model, settings, gpuInfo, onChangeSettings, onRemoveModel }: Props) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChat());
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [stats, setStats] = useState<GenStats | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => saveChat(messages), [messages]);

  const busy = streaming !== null;

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const userMsg: ChatMessage = { id: uid(), role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setStreaming('');
    setStats(null);
    await activateKeepAwakeAsync('gen');
    try {
      const { text: reply, stats: st } = await generateReply(history, settings, (t) => setStreaming(t));
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: reply || '(빈 응답)' }]);
      setStats(st);
    } catch (e: any) {
      Alert.alert('생성 오류', String(e?.message ?? e));
    } finally {
      deactivateKeepAwake('gen');
      setStreaming(null);
    }
  };

  const newChat = () => {
    if (busy) return;
    setMessages([]);
    setStats(null);
    resetConversationCache().catch(() => {});
  };

  const data: ChatMessage[] =
    streaming !== null ? [...messages, { id: '__streaming__', role: 'assistant', content: streaming || '…' }] : messages;

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text style={styles.title}>Gemma 3 4B</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            오프라인 · {gpuInfo}
            {stats ? ` · ${stats.tokPerSec.toFixed(1)} tok/s` : ''}
          </Text>
        </View>
        <Pressable onPress={newChat} style={styles.hBtn} disabled={busy}>
          <Text style={styles.hBtnText}>새 대화</Text>
        </Pressable>
        <Pressable onPress={() => setShowSettings(true)} style={styles.hBtn} disabled={busy}>
          <Text style={styles.hBtnText}>설정</Text>
        </Pressable>
      </View>

      <UpdateBanner busy={busy} />

      <FlatList
        ref={listRef}
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={data}
        keyExtractor={(m) => m.id}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <Text style={styles.empty}>무엇이든 물어보세요.{'\n'}모든 처리는 이 기기 안에서만 이루어집니다.</Text>
        }
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.botBubble]}>
            {item.role === 'assistant' ? (
              <Markdown text={item.content} />
            ) : (
              <Text selectable style={[styles.msg, styles.userText]}>
                {item.content}
              </Text>
            )}
          </View>
        )}
      />

      <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="메시지 입력"
          placeholderTextColor={colors.muted}
          multiline
          editable={!busy}
        />
        {busy ? (
          <Pressable style={[styles.send, { backgroundColor: colors.danger }]} onPress={() => stopGeneration()}>
            <Text style={styles.sendText}>중지</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.send, !input.trim() && styles.off]} onPress={send} disabled={!input.trim()}>
            <Text style={styles.sendText}>전송</Text>
          </Pressable>
        )}
      </View>

      <SettingsModal
        visible={showSettings}
        model={model}
        settings={settings}
        onClose={() => setShowSettings(false)}
        onSave={(s) => {
          setShowSettings(false);
          onChangeSettings(s);
        }}
        onRemoveModel={() => {
          setShowSettings(false);
          onRemoveModel();
        }}
      />
    </KeyboardAvoidingView>
  );
}

function SettingsModal({
  visible,
  model,
  settings,
  onClose,
  onSave,
  onRemoveModel,
}: {
  visible: boolean;
  model: InstalledModel;
  settings: Settings;
  onClose: () => void;
  onSave: (s: Settings) => void;
  onRemoveModel: () => void;
}) {
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings, visible]);
  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : d);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.settings}>
        <Text style={styles.title}>설정</Text>

        <Text style={styles.label}>시스템 프롬프트</Text>
        <TextInput
          style={[styles.field, { minHeight: 90 }]}
          multiline
          value={s.systemPrompt}
          onChangeText={(v) => setS({ ...s, systemPrompt: v })}
        />

        <Text style={styles.label}>컨텍스트 길이 (n_ctx, 변경 시 모델 재로딩)</Text>
        <TextInput
          style={styles.field}
          keyboardType="number-pad"
          defaultValue={String(s.nCtx)}
          onEndEditing={(e) => setS({ ...s, nCtx: Math.min(32768, Math.max(1024, num(e.nativeEvent.text, s.nCtx))) })}
        />

        <Text style={styles.label}>최대 생성 토큰</Text>
        <TextInput
          style={styles.field}
          keyboardType="number-pad"
          defaultValue={String(s.maxNewTokens)}
          onEndEditing={(e) =>
            setS({ ...s, maxNewTokens: Math.min(4096, Math.max(32, num(e.nativeEvent.text, s.maxNewTokens))) })
          }
        />

        <Text style={styles.label}>temperature</Text>
        <TextInput
          style={styles.field}
          keyboardType="decimal-pad"
          defaultValue={String(s.temperature)}
          onEndEditing={(e) =>
            setS({ ...s, temperature: Math.min(2, Math.max(0, num(e.nativeEvent.text, s.temperature))) })
          }
        />

        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.label}>GPU 가속 (변경 시 재로딩)</Text>
            <Text style={styles.hint}>iOS: Metal / Android: Adreno OpenCL. 느려지거나 오류가 나면 끄세요.</Text>
          </View>
          <Switch value={s.useGpu} onValueChange={(v) => setS({ ...s, useGpu: v })} />
        </View>

        <View style={styles.row}>
          <Pressable style={[styles.send, styles.flex, { backgroundColor: colors.border }]} onPress={onClose}>
            <Text style={[styles.sendText, { color: colors.text }]}>취소</Text>
          </Pressable>
          <Pressable style={[styles.send, styles.flex]} onPress={() => onSave(s)}>
            <Text style={styles.sendText}>저장</Text>
          </Pressable>
        </View>

        <Text style={[styles.label, { marginTop: 24 }]}>앱 버전</Text>
        <Text style={styles.hint}>{describeAppVersion()}</Text>
        <Pressable style={[styles.send, { backgroundColor: colors.border, marginTop: 8 }]} onPress={checkForUpdateInteractive}>
          <Text style={[styles.sendText, { color: colors.text }]}>업데이트 확인</Text>
        </Pressable>

        <Text style={[styles.label, { marginTop: 24 }]}>모델</Text>
        <Text style={styles.hint}>
          {model.name} ({formatBytes(model.size)})
        </Text>
        <Pressable
          style={[styles.send, { backgroundColor: colors.danger, marginTop: 8 }]}
          onPress={() =>
            Alert.alert('모델 삭제', '기기에서 모델 파일을 삭제합니다. 다시 쓰려면 파일을 다시 넣어야 합니다.', [
              { text: '취소', style: 'cancel' },
              { text: '삭제', style: 'destructive', onPress: onRemoveModel },
            ])
          }
        >
          <Text style={styles.sendText}>모델 삭제 / 교체</Text>
        </Pressable>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 6,
  },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 12, color: colors.muted, marginTop: 2 },
  hBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.card },
  hBtnText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  list: { padding: 12, gap: 10, flexGrow: 1 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 80, lineHeight: 22 },
  bubble: { maxWidth: '88%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.userBubble },
  botBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.botBubble,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  msg: { fontSize: 15, lineHeight: 22, color: colors.text },
  userText: { color: '#fff' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 42,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: 16,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  off: { opacity: 0.4 },
  settings: { padding: 20, gap: 8 },
  label: { fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 8 },
  hint: { fontSize: 12, color: colors.muted },
  field: {
    borderRadius: 10,
    padding: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    textAlignVertical: 'top',
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  row: { flexDirection: 'row', gap: 10, marginTop: 16 },
});

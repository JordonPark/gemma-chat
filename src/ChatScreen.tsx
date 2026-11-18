import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
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
  generateIllustration,
  generateReply,
  resetConversationCache,
  stopGeneration,
  type ChatMessage,
  type GenStats,
  type Settings,
} from './llm';
import { formatBytes, type InstalledModel } from './modelStore';
import { Markdown } from './Markdown';
import { SvgCard } from './SvgCard';
import { UpdateBanner, checkForUpdateInteractive, describeAppVersion } from './UpdateBanner';
import { loadChat, saveChat } from './storage';
import { colors } from './theme';
import { describeVision, useVision, type VisionStatus } from './useVision';
import { deleteImages, pickImage, type ImageSource } from './vision';

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
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  /** 일러스트를 그리는 중이면 { 설명, 미리보기 SVG, 받은 글자 수 } */
  const [drawing, setDrawing] = useState<{ desc: string; svg: string | null; chars: number } | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const vision = useVision(settings);

  useEffect(() => saveChat(messages), [messages]);

  const busy = streaming !== null || drawing !== null;
  const canSend = !!input.trim() || !!pendingImage;

  const attach = () => {
    if (busy || !vision.ensureReady()) return;
    const go = async (src: ImageSource) => {
      try {
        const uri = await pickImage(src);
        if (uri) setPendingImage(uri);
      } catch (e: any) {
        Alert.alert('사진', String(e?.message ?? e));
      }
    };
    Alert.alert('사진 첨부', '사진은 이 기기 안에서만 처리됩니다.', [
      { text: '카메라로 찍기', onPress: () => go('camera') },
      { text: '앨범에서 고르기', onPress: () => go('library') },
      { text: '취소', style: 'cancel' },
    ]);
  };

  /** 설명을 받아 SVG 일러스트를 그린다 */
  const draw = async (desc: string) => {
    if (busy) return;
    const d = desc.trim();
    if (!d) {
      Alert.alert('그림 그리기', '무엇을 그릴지 입력창에 적은 뒤 🎨 를 누르세요.\n예: 우주를 나는 고양이, 노을 지는 바닷가');
      return;
    }
    setMessages((prev) => [...prev, { id: uid(), role: 'user', content: `🎨 ${d}` }]);
    setInput('');
    setStats(null);
    setDrawing({ desc: d, svg: null, chars: 0 });
    await activateKeepAwakeAsync('draw');
    try {
      const { svg, stats: st } = await generateIllustration(d, (svgPart, chars) =>
        setDrawing((prev) => (prev ? { ...prev, svg: svgPart ?? prev.svg, chars } : prev)),
      );
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: `[일러스트: ${d}]`, svg }]);
      setStats(st);
    } catch (e: any) {
      Alert.alert('그리기 오류', String(e?.message ?? e));
    } finally {
      deactivateKeepAwake('draw');
      setDrawing(null);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!canSend || busy) return;
    // "…그려줘", "…그림 그려 주세요", "…일러스트 만들어줘" 는 그림 그리기로 보낸다 (사진 첨부가 없을 때)
    if (!pendingImage && /(그려\s*(줘|주세요|줄래|봐)|그림\s*(을\s*)?(그려|만들어)|일러스트\s*(를\s*)?(그려|만들어))/.test(text)) {
      return draw(text);
    }
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text || (pendingImage ? '이 사진에 무엇이 있는지 설명하고, 보이는 글자가 있으면 읽어 주세요.' : ''),
      ...(pendingImage ? { image: pendingImage } : {}),
    };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setPendingImage(null);
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
    setPendingImage(null);
    deleteImages();
    resetConversationCache().catch(() => {});
  };

  const data: ChatMessage[] =
    streaming !== null
      ? [...messages, { id: '__streaming__', role: 'assistant', content: streaming || '…' }]
      : drawing !== null
        ? [...messages, { id: '__drawing__', role: 'assistant', content: '', svg: drawing.svg ?? '' }]
        : messages;

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
      <VisionDownloadBar status={vision.status} onCancel={vision.cancelDownload} />

      <FlatList
        ref={listRef}
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={data}
        keyExtractor={(m) => m.id}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <Text style={styles.empty}>
            무엇이든 물어보세요.{'\n'}📷 사진에 대해 묻거나, 🎨 로 일러스트를 그려 보세요.{'\n'}모든 처리는 이 기기 안에서만 이루어집니다.
          </Text>
        }
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.botBubble]}>
            {item.id === '__drawing__' && drawing ? (
              drawing.svg ? (
                <SvgCard svg={drawing.svg} live caption={`그리는 중… (${drawing.chars}자)`} />
              ) : (
                <Text style={styles.msg}>🎨 그림을 구상하는 중… ({drawing.chars}자)</Text>
              )
            ) : item.role === 'assistant' && item.svg ? (
              <SvgCard svg={item.svg} caption={item.content.replace(/^\[일러스트: (.*)\]$/, '$1')} />
            ) : item.role === 'assistant' ? (
              <Markdown text={item.content} />
            ) : (
              <>
                {item.image ? <Image source={{ uri: item.image }} style={styles.msgImage} resizeMode="cover" /> : null}
                <Text selectable style={[styles.msg, styles.userText]}>
                  {item.content}
                </Text>
              </>
            )}
          </View>
        )}
      />

      {pendingImage ? (
        <View style={styles.pending}>
          <Image source={{ uri: pendingImage }} style={styles.pendingImage} />
          <Text style={styles.pendingText}>사진 첨부됨 · 질문을 적거나 그대로 전송하세요</Text>
          <Pressable onPress={() => setPendingImage(null)} style={styles.pendingX}>
            <Text style={styles.pendingXText}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <Pressable style={[styles.attach, busy && styles.off]} onPress={attach} disabled={busy}>
          <Text style={styles.attachText}>📷</Text>
        </Pressable>
        <Pressable style={[styles.attach, busy && styles.off]} onPress={() => draw(input)} disabled={busy}>
          <Text style={styles.attachText}>🎨</Text>
        </Pressable>
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
          <Pressable style={[styles.send, !canSend && styles.off]} onPress={send} disabled={!canSend}>
            <Text style={styles.sendText}>전송</Text>
          </Pressable>
        )}
      </View>

      <SettingsModal
        visible={showSettings}
        model={model}
        settings={settings}
        visionStatus={vision.status}
        onDownloadVision={vision.download}
        onRemoveVision={vision.remove}
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
  visionStatus,
  onDownloadVision,
  onRemoveVision,
  onClose,
  onSave,
  onRemoveModel,
}: {
  visible: boolean;
  model: InstalledModel;
  settings: Settings;
  visionStatus: VisionStatus;
  onDownloadVision: () => void;
  onRemoveVision: () => void;
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

        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.label}>이미지 인식 (사진 첨부)</Text>
            <Text style={styles.hint}>
              상태: {describeVision(visionStatus)}. 메모리를 약 1GB 더 씁니다. 앱이 꺼지면 끄세요.
            </Text>
          </View>
          <Switch value={s.vision} onValueChange={(v) => setS({ ...s, vision: v })} />
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

        <Text style={[styles.label, { marginTop: 24 }]}>이미지 인식 파일</Text>
        <Text style={styles.hint}>{describeVision(visionStatus)}</Text>
        {visionStatus.kind === 'missing' ? (
          <Pressable style={[styles.send, { marginTop: 8 }]} onPress={onDownloadVision}>
            <Text style={styles.sendText}>이미지 인식 파일 받기 (약 0.85GB)</Text>
          </Pressable>
        ) : visionStatus.kind !== 'downloading' && visionStatus.kind !== 'checking' ? (
          <Pressable
            style={[styles.send, { backgroundColor: colors.border, marginTop: 8 }]}
            onPress={() =>
              Alert.alert('이미지 인식 파일 삭제', '약 0.85GB 를 비웁니다. 사진 기능을 다시 쓰려면 다시 받아야 합니다.', [
                { text: '취소', style: 'cancel' },
                { text: '삭제', style: 'destructive', onPress: onRemoveVision },
              ])
            }
          >
            <Text style={[styles.sendText, { color: colors.text }]}>이미지 인식 파일 삭제</Text>
          </Pressable>
        ) : null}

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
  attach: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  attachText: { fontSize: 20 },
  msgImage: { width: 220, height: 220, borderRadius: 10, marginBottom: 6 },
  pending: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  pendingImage: { width: 52, height: 52, borderRadius: 8 },
  pendingText: { flex: 1, fontSize: 13, color: colors.muted },
  pendingX: { padding: 8 },
  pendingXText: { fontSize: 16, color: colors.muted },
  dlBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dlText: { fontSize: 13, color: colors.text, marginBottom: 6 },
  dlTrack: { height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: 'hidden' },
  dlFill: { height: 4, backgroundColor: colors.accent },
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

function VisionDownloadBar({ status, onCancel }: { status: VisionStatus; onCancel: () => void }) {
  if (status.kind !== 'downloading') return null;
  const pct = Math.round((status.progress?.ratio ?? 0) * 100);
  return (
    <View style={styles.dlBar}>
      <View style={styles.flex}>
        <Text style={styles.dlText}>
          이미지 인식 파일 받는 중 {pct}% {status.progress?.detail ? `· ${status.progress.detail}` : ''}
        </Text>
        <View style={styles.dlTrack}>
          <View style={[styles.dlFill, { width: `${pct}%` }]} />
        </View>
      </View>
      <Pressable onPress={onCancel} style={styles.hBtn}>
        <Text style={[styles.hBtnText, { color: colors.danger }]}>취소</Text>
      </Pressable>
    </View>
  );
}

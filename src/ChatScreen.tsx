import { useEffect, useRef, useState, type ComponentRef } from 'react';
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
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Sharing from 'expo-sharing';
import {
  generateIllustration,
  generateReply,
  loadModel,
  makeImagePrompt,
  resetConversationCache,
  stopGeneration,
  unloadModel,
  type ChatMessage,
  type GenStats,
  type Settings,
} from './llm';
import type { AreaSize } from '../modules/gemma-fold';
import { FoldAwareArea } from './FoldAwareArea';
import { getChatLayout, minInlineComposerWidth, type Division } from './foldLayout';
import { cancelImageGen, deletePictures, drawPicture } from './imageGen';
import { describeImageModel, useImageModel, type ImageModelStatus } from './useImageModel';
import { formatBytes, type InstalledModel } from './modelStore';
import { Markdown } from './Markdown';
import { SvgCard } from './SvgCard';
import { UpdateBanner, checkForUpdateInteractive, describeAppVersion } from './UpdateBanner';
import { loadChat, saveChat } from './storage';
import { colors } from './theme';
import { describeVision, useVision, type VisionStatus } from './useVision';
import { deleteImages, pickImage, type ImageSource } from './vision';
import { isOcrAvailable, recognizeText } from '../modules/expo-ocr';
import { clearTempFiles, storageBreakdown } from './storageInfo';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type Props = {
  model: InstalledModel;
  settings: Settings;
  gpuInfo: string;
  onChangeSettings: (s: Settings) => void;
  onRemoveModel: () => void;
};

export function ChatScreen({ model, settings, gpuInfo, onChangeSettings, onRemoveModel }: Props) {
  const { fontScale } = useWindowDimensions();
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChat());
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [stats, setStats] = useState<GenStats | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  /** 첨부한 사진의 OCR 결과. undefined = 읽는 중, null = 실패/불가, string = 결과(빈 문자열이면 글자 없음) */
  const [pendingOcr, setPendingOcr] = useState<string | null | undefined>(null);
  const ocrJob = useRef<Promise<string | null> | null>(null);
  /** 일러스트를 그리는 중이면 { 설명, 미리보기 SVG, 받은 글자 수 } */
  const [drawing, setDrawing] = useState<{
    desc: string;
    svg: string | null;
    chars: number;
    /** 그림 모델(iOS)로 그리는 중이면 지금 단계 설명 */
    phase?: string;
    progress?: number;
  } | null>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const followLatest = useRef(true);
  const vision = useVision(settings);
  const imageModel = useImageModel();
  const usePictureModel = imageModel.status.kind !== 'unsupported';

  useEffect(() => saveChat(messages), [messages]);

  const busy = streaming !== null || drawing !== null;
  const canSend = !!input.trim() || !!pendingImage;

  const clearPending = () => {
    setPendingImage(null);
    setPendingOcr(null);
    ocrJob.current = null;
  };

  /** 사진을 고르면 바로 OCR 을 돌려 둔다 (보통 1초 안팎) */
  const startOcr = (uri: string) => {
    if (!isOcrAvailable()) {
      setPendingOcr(null);
      ocrJob.current = Promise.resolve(null);
      return;
    }
    setPendingOcr(undefined);
    const job = recognizeText(uri)
      .then((r) => r.text)
      .catch(() => null);
    ocrJob.current = job;
    job.then((t) => {
      if (ocrJob.current === job) setPendingOcr(t);
    });
  };

  const attach = () => {
    if (busy) return;
    // 이미지 인식(Gemma 비전)이 없어도 OCR 이 있으면 사진의 글자로 답할 수 있다
    if (!isOcrAvailable() && !vision.ensureReady()) return;
    const go = async (src: ImageSource) => {
      try {
        const uri = await pickImage(src);
        if (uri) {
          setPendingImage(uri);
          startOcr(uri);
        }
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

  /**
   * iPhone: 그림 모델(Stable Diffusion)로 수채화 동화풍 그림을 그린다.
   * 메모리를 위해 채팅 모델을 잠시 내렸다가, 다 그리면 다시 올린다.
   */
  const drawWithModel = async (d: string) => {
    followLatest.current = true;
    setMessages((prev) => [...prev, { id: uid(), role: 'user', content: `🎨 ${d}` }]);
    setInput('');
    setStats(null);
    const phase = (p: string, progress?: number) =>
      setDrawing({ desc: d, svg: null, chars: 0, phase: p, progress });
    phase('그릴 장면을 구상하는 중…');
    await activateKeepAwakeAsync('draw');
    let unloaded = false;
    try {
      const prompt = await makeImagePrompt(d);
      phase('메모리 확보 중…');
      await unloadModel();
      unloaded = true;
      const uri = await drawPicture(prompt, (stage, p) =>
        stage === 'loading'
          ? phase('그림 모델 준비 중… (처음 한 번은 1~3분)')
          : phase(`그리는 중 ${p?.step ?? 0}/${p?.stepCount ?? 25}`, p ? p.step / Math.max(1, p.stepCount) : 0),
      );
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: `[그림: ${d}]`, picture: uri }]);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!/취소/.test(msg)) Alert.alert('그리기 오류', msg);
    } finally {
      if (unloaded) {
        phase('채팅 모델 다시 불러오는 중…');
        try {
          await loadModel(model.path, settings);
          vision.retry();
        } catch (e: any) {
          Alert.alert('채팅 모델을 다시 불러오지 못했습니다', `앱을 껐다 켜 주세요.\n(${e?.message ?? e})`);
        }
      }
      deactivateKeepAwake('draw');
      setDrawing(null);
    }
  };

  /** 설명을 받아 그림을 그린다 (iPhone: 그림 모델, 그 외: 도형 일러스트) */
  const draw = async (desc: string) => {
    if (busy) return;
    const d = desc.trim();
    if (!d) {
      Alert.alert('그림 그리기', '무엇을 그릴지 입력창에 적은 뒤 🎨 를 누르세요.\n예: 우주를 나는 고양이, 노을 지는 바닷가');
      return;
    }
    if (usePictureModel) {
      if (!imageModel.ensureReady()) return;
      return drawWithModel(d);
    }
    followLatest.current = true;
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

  /** 첨부 사진의 글자만 바로 보여 준다 (Gemma 를 거치지 않음) */
  const readTextOnly = async () => {
    if (!pendingImage || busy) return;
    const image = pendingImage;
    const text = (await ocrJob.current) ?? null;
    clearPending();
    followLatest.current = true;
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', content: '📝 사진 속 글자 읽기', image, ...(text ? { ocr: text } : {}) },
      {
        id: uid(),
        role: 'assistant',
        content:
          text == null
            ? '글자를 읽지 못했습니다. 다시 시도해 주세요.'
            : text
              ? `**사진 속 글자** (기기 OCR, 길게 눌러 복사)\n\n\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``
              : '사진에서 글자를 찾지 못했습니다.',
      },
    ]);
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
    if (pendingImage) {
      const ocr = (await ocrJob.current) ?? null; // 아직 읽는 중이면 끝날 때까지 기다린다 (보통 1초 안팎)
      if (ocr) userMsg.ocr = ocr;
      // 이미지 인식이 준비 안 됐고 글자도 없으면, 이미지 인식 파일 안내를 띄운다
      if (vision.status.kind !== 'ready' && !ocr && !vision.ensureReady()) return;
    }
    const history = [...messages, userMsg];
    followLatest.current = true;
    setMessages(history);
    setInput('');
    clearPending();
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
    followLatest.current = true;
    setMessages([]);
    setStats(null);
    clearPending();
    deleteImages();
    deletePictures();
    resetConversationCache().catch(() => {});
  };

  const data: ChatMessage[] =
    streaming !== null
      ? [...messages, { id: '__streaming__', role: 'assistant', content: streaming || '…' }]
      : drawing !== null
        ? [...messages, { id: '__drawing__', role: 'assistant', content: '', svg: drawing.svg ?? '' }]
        : messages;

  const openSettings = () => setShowSettings(true);
  const draftIllustration = () => {
    if (!input.trim()) setInput('별빛이 비치는 바닷가를 그려줘');
    inputRef.current?.focus();
  };
  const scrollToLatest = () => {
    if (followLatest.current && data.length > 0) listRef.current?.scrollToEnd({ animated: false });
  };

  const renderWorkspace = (size: AreaSize, division: Division | null) => {
    const layout = getChatLayout(size, division, !!pendingImage, fontScale);
    const showSidebar = layout.sidebarWidth > 0;
    const splitTranscript = layout.transcriptHeight !== undefined;
    const paneWidth = size.width - layout.sidebarWidth - layout.sidebarGap
      - (layout.insets.left ?? 0) - (layout.insets.right ?? 0);
    const narrow = paneWidth > 0 && paneWidth < 340;
    const stackComposer = paneWidth > 0 && paneWidth < minInlineComposerWidth(fontScale);
    const mediaSize = Math.min(260, Math.max(96, (paneWidth || 350) * 0.78 - 48));
    const composerHeight = size.height - (layout.transcriptHeight ?? 0) - layout.foldGap;
    const inputHeight = splitTranscript
      ? Math.min(120, Math.max(44, composerHeight - (pendingImage ? 86 : 28) - (stackComposer ? 48 : 0)))
      : 120;

    return (
      <View style={[styles.workspace, {
        paddingLeft: layout.insets.left,
        paddingRight: layout.insets.right,
        paddingTop: layout.insets.top,
        paddingBottom: layout.insets.bottom,
      }]}>
        {showSidebar ? (
          <View style={[styles.sidebar, { width: layout.sidebarWidth, marginRight: layout.sidebarGap }]}>
            <ScrollView contentContainerStyle={styles.sidebarContent} keyboardShouldPersistTaps="handled">
              <View style={styles.identity}>
                <BrandMark />
                <View style={styles.flex}>
                  <Text style={styles.title} accessibilityRole="header">Gemma Chat</Text>
                  <Text style={styles.subtitle}>오프라인 AI</Text>
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={newChat}
                disabled={busy}
                style={[styles.sidebarPrimary, busy && styles.off]}
              >
                <Text style={styles.sendText}>＋ 새 대화</Text>
              </Pressable>
              <View style={styles.sidebarActions}>
                <ChatAction icon="📷" label="사진으로 질문" onPress={attach} disabled={busy} />
                <ChatAction icon="🎨" label="일러스트 그리기" onPress={draftIllustration} disabled={busy} />
                <ChatAction icon="⚙" label="설정" onPress={openSettings} disabled={busy} />
              </View>
              <View style={styles.modelInfo}>
                <Text style={styles.shortcutTitle}>Gemma 3 4B</Text>
                <Text style={styles.subtitle}>
                  {gpuInfo}{stats ? ` · ${stats.tokPerSec.toFixed(1)} tok/s` : ''}
                </Text>
              </View>
            </ScrollView>
          </View>
        ) : null}
        <View style={styles.conversation}>
          <View style={splitTranscript ? { height: layout.transcriptHeight, overflow: 'hidden' } : styles.transcript}>
            <View style={styles.header}>
              {!showSidebar ? <BrandMark /> : null}
              <View style={styles.flex}>
                <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
                  {showSidebar ? '대화' : 'Gemma Chat'}
                </Text>
                {!showSidebar ? (
                  <Text style={styles.subtitle} numberOfLines={1}>
                    Gemma 3 4B · {gpuInfo}
                    {stats ? ` · ${stats.tokPerSec.toFixed(1)} tok/s` : ''}
                  </Text>
                ) : null}
              </View>
              {!showSidebar ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="새 대화"
                    onPress={newChat}
                    style={[styles.hBtn, busy && styles.off]}
                    disabled={busy}
                  >
                    <Text style={styles.hBtnText}>{narrow ? '＋' : '새 대화'}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="설정"
                    onPress={openSettings}
                    style={[styles.hBtn, busy && styles.off]}
                    disabled={busy}
                  >
                    <Text style={styles.hBtnText}>{narrow ? '⚙' : '설정'}</Text>
                  </Pressable>
                </>
              ) : null}
            </View>

            <UpdateBanner busy={busy} />
            <VisionDownloadBar status={vision.status} onCancel={vision.cancelDownload} />
            {imageModel.status.kind === 'downloading' ? (
              <View style={styles.dlBar}>
                <View style={styles.flex}>
                  <Text style={styles.dlText} numberOfLines={1}>
                    그림 모델 {describeImageModel(imageModel.status)}
                  </Text>
                  <View style={styles.dlTrack}>
                    <View style={[styles.dlFill, { width: `${Math.round((imageModel.status.progress?.ratio ?? 0) * 100)}%` }]} />
                  </View>
                </View>
                <Pressable onPress={imageModel.cancelDownload} style={styles.hBtn}>
                  <Text style={[styles.hBtnText, { color: colors.danger }]}>취소</Text>
                </Pressable>
              </View>
            ) : null}

            <FlatList
              ref={listRef}
              style={styles.flex}
              contentContainerStyle={[styles.list, data.length === 0 && styles.emptyList]}
              keyboardShouldPersistTaps="handled"
              data={data}
              keyExtractor={(m) => m.id}
              maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
              onLayout={scrollToLatest}
              onContentSizeChange={scrollToLatest}
              onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
                followLatest.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 48;
              }}
              scrollEventThrottle={32}
              ListEmptyComponent={
                <View style={styles.welcome}>
                  <View style={styles.welcomeMark} accessible={false}>
                    <Text style={styles.welcomeGlyph}>✦</Text>
                  </View>
                  <Text style={styles.welcomeTitle} accessibilityRole="header">무엇을 도와드릴까요?</Text>
                  <Text style={styles.welcomeDescription}>
                    인터넷 연결 없이 대화할 수 있어요. 모든 대화는 이 기기 안에서 처리됩니다.
                  </Text>
                  {!showSidebar ? (
                    <View style={[styles.shortcuts, narrow && styles.stackedShortcuts]}>
                      <ChatAction icon="📷" label="사진으로 질문" onPress={attach} />
                      <ChatAction icon="🎨" label="일러스트 그리기" onPress={draftIllustration} />
                    </View>
                  ) : null}
                </View>
              }
              renderItem={({ item }) => (
                <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.botBubble]}>
                  {item.id === '__drawing__' && drawing?.phase ? (
                    <View style={styles.drawProgress}>
                      <Text style={styles.msg}>🎨 {drawing.phase}</Text>
                      {drawing.progress != null ? (
                        <View style={styles.dlTrack}>
                          <View style={[styles.dlFill, { width: `${Math.round(drawing.progress * 100)}%` }]} />
                        </View>
                      ) : null}
                    </View>
                  ) : item.id === '__drawing__' && drawing ? (
                    drawing.svg ? (
                      <SvgCard svg={drawing.svg} size={mediaSize} live caption={`그리는 중… (${drawing.chars}자)`} />
                    ) : (
                      <Text style={styles.msg}>🎨 그림을 구상하는 중… ({drawing.chars}자)</Text>
                    )
                  ) : item.role === 'assistant' && item.picture ? (
                    <PictureCard uri={item.picture} size={mediaSize} caption={item.content.replace(/^\[그림: (.*)\]$/, '$1')} />
                  ) : item.role === 'assistant' && item.svg ? (
                    <SvgCard svg={item.svg} size={mediaSize} caption={item.content.replace(/^\[일러스트: (.*)\]$/, '$1')} />
                  ) : item.role === 'assistant' ? (
                    <Markdown text={item.content} />
                  ) : (
                    <>
                      {item.image ? (
                        <Image source={{ uri: item.image }} style={[styles.msgImage, { width: mediaSize, height: mediaSize }]} resizeMode="cover" />
                      ) : null}
                      <Text selectable style={[styles.msg, styles.userText]}>{item.content}</Text>
                    </>
                  )}
                </View>
              )}
            />
          </View>

          <View style={splitTranscript ? [styles.lowerPane, { marginTop: layout.foldGap }] : styles.composerPane}>
            <View style={styles.composer}>
              {pendingImage ? (
                <View style={styles.pending}>
                  <Image source={{ uri: pendingImage }} style={styles.pendingImage} />
                  <Text style={styles.pendingText} numberOfLines={2}>
                    {pendingOcr === undefined
                      ? '글자 읽는 중…'
                      : pendingOcr
                        ? `글자 ${pendingOcr.length}자 인식`
                        : '사진 첨부됨'}
                  </Text>
                  {isOcrAvailable() ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={readTextOnly}
                      style={styles.pendingBtn}
                      disabled={busy || pendingOcr === undefined}
                    >
                      <Text style={styles.pendingBtnText}>글자 읽기</Text>
                    </Pressable>
                  ) : null}
                  <Pressable onPress={clearPending} style={styles.pendingX} accessibilityRole="button" accessibilityLabel="첨부 사진 제거">
                    <Text style={styles.pendingXText}>✕</Text>
                  </Pressable>
                </View>
              ) : null}
              <View style={[styles.inputRow, stackComposer && styles.stackedInput]}>
                <TextInput
                  ref={inputRef}
                  accessibilityLabel="메시지 입력"
                  style={[styles.input, { maxHeight: inputHeight }]}
                  value={input}
                  onChangeText={setInput}
                  placeholder="메시지 입력"
                  placeholderTextColor={colors.muted}
                  multiline
                  editable={!busy}
                />
                <View style={styles.composerActions}>
                  <Pressable
                    style={[styles.attach, busy && styles.off]}
                    onPress={attach}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="사진 첨부"
                  >
                    <Text style={styles.attachText}>📷</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.attach, busy && styles.off]}
                    onPress={() => draw(input)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="일러스트 그리기"
                  >
                    <Text style={styles.attachText}>🎨</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    style={[styles.send, busy && { backgroundColor: colors.danger }, !busy && !canSend && styles.off]}
                    onPress={busy ? () => (drawing?.phase ? cancelImageGen() : stopGeneration()) : send}
                    disabled={!busy && !canSend}
                  >
                    <Text style={styles.sendText}>{busy ? '중지' : '전송'}</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </View>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <SafeAreaView style={styles.flex}>
        <FoldAwareArea>{renderWorkspace}</FoldAwareArea>
      </SafeAreaView>

      {showSettings ? (
        <SettingsModal
          model={model}
          settings={settings}
          visionStatus={vision.status}
          onDownloadVision={vision.download}
          onRemoveVision={vision.remove}
          imageModelStatus={imageModel.status}
          onDownloadImageModel={imageModel.download}
          onRemoveImageModel={imageModel.remove}
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
      ) : null}
    </KeyboardAvoidingView>
  );
}

function BrandMark() {
  return (
    <View style={styles.brandMark} accessible={false}>
      <Text style={styles.brandGlyph}>✦</Text>
    </View>
  );
}

function ChatAction({ icon, label, disabled, onPress }: {
  icon: string;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.shortcut, (pressed || disabled) && styles.off]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.shortcutIcon}>{icon}</Text>
      <Text style={styles.shortcutTitle}>{label}</Text>
    </Pressable>
  );
}

function SettingsModal({
  model,
  settings,
  visionStatus,
  onDownloadVision,
  onRemoveVision,
  imageModelStatus,
  onDownloadImageModel,
  onRemoveImageModel,
  onClose,
  onSave,
  onRemoveModel,
}: {
  model: InstalledModel;
  settings: Settings;
  visionStatus: VisionStatus;
  onDownloadVision: () => void;
  onRemoveVision: () => void;
  imageModelStatus: ImageModelStatus;
  onDownloadImageModel: () => void;
  onRemoveImageModel: () => void;
  onClose: () => void;
  onSave: (s: Settings) => void;
  onRemoveModel: () => void;
}) {
  const [s, setS] = useState(settings);
  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : d);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      supportedOrientations={['portrait', 'landscape']}
    >
      <ScrollView
        style={styles.settingsBackground}
        contentContainerStyle={styles.settings}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.settingsTitle}>설정</Text>

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

        <StorageSection visible busy={visionStatus.kind === 'downloading' || imageModelStatus.kind === 'downloading'} />

        {imageModelStatus.kind !== 'unsupported' ? (
          <>
            <Text style={[styles.label, { marginTop: 24 }]}>그림 모델 (수채화 동화풍)</Text>
            <Text style={styles.hint}>{describeImageModel(imageModelStatus)}</Text>
            {imageModelStatus.kind === 'missing' ? (
              <Pressable style={[styles.send, { marginTop: 8 }]} onPress={onDownloadImageModel}>
                <Text style={styles.sendText}>그림 모델 받기 (약 1.6GB)</Text>
              </Pressable>
            ) : imageModelStatus.kind === 'ready' ? (
              <Pressable
                style={[styles.send, { backgroundColor: colors.border, marginTop: 8 }]}
                onPress={() =>
                  Alert.alert('그림 모델 삭제', '약 1.6GB 를 비웁니다. 다시 그리려면 다시 받아야 합니다.', [
                    { text: '취소', style: 'cancel' },
                    { text: '삭제', style: 'destructive', onPress: onRemoveImageModel },
                  ])
                }
              >
                <Text style={[styles.sendText, { color: colors.text }]}>그림 모델 삭제</Text>
              </Pressable>
            ) : null}
            <Text style={[styles.hint, { marginTop: 6 }]}>
              Stable Diffusion 1.5 (Apple Core ML), CreativeML OpenRAIL-M 라이선스. 모든 그림은 기기 안에서 만들어집니다.
            </Text>
          </>
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

/** 설정: 앱이 쓰는 저장 공간 내역 */
function StorageSection({ visible, busy }: { visible: boolean; busy: boolean }) {
  const [info, setInfo] = useState(() => storageBreakdown());
  useEffect(() => {
    if (visible) setInfo(storageBreakdown());
  }, [visible]);
  const temp = info.items.find((i) => i.key === 'temp');
  return (
    <View style={{ marginTop: 24, gap: 6 }}>
      <Text style={styles.label}>저장 공간 · 합계 {formatBytes(info.total)}</Text>
      {info.items.map((i) => (
        <View key={i.key} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={styles.hint}>{i.label}</Text>
          <Text style={styles.hint}>{formatBytes(i.bytes)}</Text>
        </View>
      ))}
      <Text style={styles.hint}>기기 남은 공간 {formatBytes(info.free)}</Text>
      {temp ? (
        <Pressable
          style={[styles.send, { backgroundColor: colors.border, marginTop: 4 }]}
          disabled={busy}
          onPress={() => {
            const freed = clearTempFiles();
            setInfo(storageBreakdown());
            Alert.alert('정리 완료', `${formatBytes(freed)} 를 비웠습니다.`);
          }}
        >
          <Text style={[styles.sendText, { color: colors.text }]}>
            {busy ? '받는 중에는 정리할 수 없습니다' : `임시 파일 정리 (${formatBytes(temp.bytes)})`}
          </Text>
        </Pressable>
      ) : null}
      <Text style={styles.hint}>필요 없는 기능의 파일은 아래에서 각각 지울 수 있습니다. 지운 기능은 다시 쓸 때 다시 받습니다.</Text>
    </View>
  );
}

/** 기기에서 생성한 그림 카드: 크게 보기 + 저장·공유 */
function PictureCard({ uri, size, caption }: { uri: string; size: number; caption?: string }) {
  const share = async () => {
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('공유', '이 기기에서는 공유를 사용할 수 없습니다.');
        return;
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: '그림 저장·공유', UTI: 'public.png' });
    } catch (e: any) {
      Alert.alert('저장·공유 실패', String(e?.message ?? e));
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <Image source={{ uri }} style={[styles.picture, { width: size, height: size }]} resizeMode="cover" />
      {caption ? <Text style={styles.hint}>{caption}</Text> : null}
      <Pressable onPress={share} style={[styles.hBtn, { alignSelf: 'flex-start', minHeight: 44 }]}>
        <Text style={styles.hBtnText}>저장 · 공유</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  workspace: { flex: 1, flexDirection: 'row' },
  sidebar: {
    backgroundColor: colors.accentSoft,
    borderTopRightRadius: 24,
    borderBottomRightRadius: 24,
    overflow: 'hidden',
  },
  sidebarContent: {
    flexGrow: 1,
    alignSelf: 'center',
    width: '100%',
    maxWidth: 278,
    padding: 16,
    gap: 16,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  sidebarPrimary: {
    minHeight: 48,
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sidebarActions: { gap: 8 },
  modelInfo: { marginTop: 'auto', paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border },
  conversation: { flex: 1, minWidth: 0 },
  transcript: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 6,
  },
  brandMark: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandGlyph: { fontSize: 23, color: colors.accentText },
  title: { fontSize: 17, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 12, color: colors.muted, marginTop: 2 },
  hBtn: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
  },
  hBtnText: { color: colors.accentText, fontSize: 14, fontWeight: '700' },
  list: { padding: 16, gap: 12, flexGrow: 1, width: '100%', maxWidth: 740, alignSelf: 'center' },
  emptyList: { justifyContent: 'center' },
  welcome: { alignSelf: 'center', width: '100%', maxWidth: 430, paddingVertical: 12, paddingHorizontal: 6 },
  welcomeMark: {
    width: 58,
    height: 58,
    borderRadius: 19,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  welcomeGlyph: { fontSize: 32, color: colors.accentText },
  welcomeTitle: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.9 },
  welcomeDescription: { color: colors.muted, fontSize: 15, lineHeight: 23, maxWidth: 280, marginTop: 8 },
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
  stackedShortcuts: { flexDirection: 'column', alignItems: 'stretch' },
  shortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  shortcutIcon: { fontSize: 18, color: colors.accentText },
  shortcutTitle: { fontWeight: '700', fontSize: 14, color: colors.text, flexShrink: 1 },
  bubble: { maxWidth: '88%', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12 },
  userBubble: { alignSelf: 'flex-end', borderBottomRightRadius: 6, backgroundColor: colors.userBubble },
  botBubble: {
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 6,
    backgroundColor: colors.botBubble,
    borderWidth: 1,
    borderColor: colors.border,
  },
  msg: { fontSize: 15, lineHeight: 22, color: colors.text },
  userText: { color: '#fff' },
  composerPane: { backgroundColor: colors.bg },
  lowerPane: {
    flex: 1,
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.accentSoft,
  },
  composer: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    width: '100%',
    maxWidth: 740,
    alignSelf: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    padding: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  stackedInput: { flexDirection: 'column', alignItems: 'stretch' },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
  composerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 4 },
  send: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#fff', fontWeight: '700', fontSize: 15, textAlign: 'center' },
  attach: {
    width: 44,
    minHeight: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  attachText: { fontSize: 18 },
  msgImage: { borderRadius: 10, marginBottom: 8 },
  pending: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    padding: 5,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pendingImage: { width: 44, height: 44, borderRadius: 8 },
  pendingText: { flex: 1, fontSize: 13, color: colors.muted },
  pendingX: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  pendingBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.accentSoft },
  pendingBtnText: { color: colors.accentText, fontSize: 13, fontWeight: '600' },
  pendingXText: { fontSize: 16, color: colors.muted },
  picture: { borderRadius: 14 },
  drawProgress: { gap: 8 },
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
  settingsBackground: { backgroundColor: colors.bg },
  settings: { padding: 24, gap: 10, width: '100%', maxWidth: 600, alignSelf: 'center' },
  settingsTitle: { fontSize: 28, fontWeight: '800', color: colors.text, marginBottom: 8 },
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

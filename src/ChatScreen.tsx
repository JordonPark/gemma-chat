import { useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Keyboard,
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
  type AlertButton,
  type ImageStyle,
  type StyleProp,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  checkGeneratedContent,
  generateReply,
  pickTool,
  resetConversationCache,
  stopGeneration,
  type ChatMessage,
  type GenStats,
  type Settings,
} from './llm';
import type { AreaSize } from '../modules/gemma-fold';
import { ChatLibrary, type ChatScope } from './ChatLibrary';
import { conversationName, hasConversationContent, makeConversation, removeTask, type ChatLibraryData, type ChatTask, type Conversation } from './conversationLibrary';
import { DuoToolbar, hasDuoToolbar } from './DuoToolbar';
import { FoldAwareArea } from './FoldAwareArea';
import { clearMemories, loadMemories, mightNeedTool, removeMemory, runTool } from './tools';
import { getChatLayout, getFoldInsets, minInlineComposerWidth, type Division } from './foldLayout';
import { deletePictures } from './legacyDrawing';
import { ImageViewer, type ImagePreview } from './ImageViewer';
import { ContentSafetyError, cooldownSeconds, recordStrike } from './contentSafety';
import { LegalInfo } from './LegalInfo';
import { ReportContent } from './ReportContent';
import { APP_NAME, SUPPORT_BASE_URL } from './storeConfig';
import { formatBytes, type ImportProgress, type InstalledModel } from './modelStore';
import { Markdown } from './Markdown';
import { UpdateBanner, checkForUpdateInteractive, describeAppVersion } from './UpdateBanner';
import { loadChatLibrary, saveChatLibrary } from './storage';
import { colors } from './theme';
import { describeVision, useVision, type VisionStatus } from './useVision';
import { deleteImages, pickImage, type ImageSource } from './vision';
import { isOcrAvailable, isScanAvailable, recognizeText, scanText } from '../modules/expo-ocr';
import * as ImagePicker from 'expo-image-picker';
import { clearTempFiles, storageBreakdown } from './storageInfo';
import { DownloadCancelled, checkSmallerModel, downloadModel, formatDownloadEta, type ModelUpgrade } from './modelDownload';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type Props = {
  model: InstalledModel;
  settings: Settings;
  gpuInfo: string;
  initialInput?: string;
  onChangeSettings: (s: Settings) => void;
  onRemoveModel: () => void;
  /** 더 작은 모델로 교체가 끝나면 새 모델을 불러온다 */
  onModelReplaced: (m: InstalledModel) => void;
};

/** 그림 그리기 요청인지 (그림 기능은 뺐으므로 안내 문구로 답한다) */
const DRAW_INTENT =
  /(그려\s*(줘|주세요|주실|줄래|줄\s*수)|(그림|일러스트|이미지|삽화|배경\s*화면)[^.?!\n]{0,10}(만들어|생성해|그려))/;

export function ChatScreen({ model, settings, gpuInfo, initialInput = '', onChangeSettings, onRemoveModel, onModelReplaced }: Props) {
  const { fontScale } = useWindowDimensions();
  const [library, setLibrary] = useState(loadChatLibrary);
  const libraryRef = useRef(library);
  const activeChat = library.chats.find((chat) => chat.id === library.activeId)!;
  const { messages } = activeChat;
  const activeTask = library.tasks.find((task) => task.id === activeChat.taskId);
  const [scope, setScope] = useState<ChatScope>(activeTask?.id);
  const [showLibrary, setShowLibrary] = useState(false);
  const [input, setInput] = useState(initialInput || activeChat.draft?.input || '');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [stats, setStats] = useState<GenStats | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [reportItem, setReportItem] = useState<ChatMessage | null>(null);
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [pendingImage, setPendingImage] = useState<string | null>(activeChat.draft?.image ?? null);
  /** 첨부한 사진의 OCR 결과. undefined = 읽는 중, null = 실패/불가, string = 결과(빈 문자열이면 글자 없음) */
  const [pendingOcr, setPendingOcr] = useState<string | null | undefined>(null);
  const ocrJob = useRef<Promise<string | null> | null>(null);
  const workPending = useRef(false);
  const conversationCache = useRef(Promise.resolve());
  const [workingWithPhoto, setWorkingWithPhoto] = useState(false);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const followLatest = useRef(true);
  const vision = useVision(settings);

  // ── 더 작은 채팅 모델로 교체 (설정을 열 때 한 번 확인) ──
  const [upgrade, setUpgrade] = useState<ModelUpgrade | null>(null);
  const [upgradeDl, setUpgradeDl] = useState<{ progress: ImportProgress | null } | null>(null);
  const upgradeChecked = useRef(false);
  const upgradeAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!showSettings || upgradeChecked.current) return;
    upgradeChecked.current = true;
    checkSmallerModel(model).then(setUpgrade);
  }, [showSettings, model]);
  const startUpgrade = () => {
    if (!upgrade || upgradeDl) return;
    Alert.alert(
      '더 작은 모델로 교체',
      `같은 Gemma 3 4B 에서 단어 사전 부분만 더 압축한 모델입니다 (답변 품질은 거의 같음).\n\n` +
        `${formatBytes(upgrade.size)} 를 받고, 끝나면 지금 모델을 지워 ${formatBytes(upgrade.saving)} 를 아낍니다. ` +
        `받는 동안 대화는 계속할 수 있습니다. Wi-Fi 권장.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '교체',
          onPress: async () => {
            const ac = new AbortController();
            upgradeAbort.current = ac;
            setUpgradeDl({ progress: null });
            await activateKeepAwakeAsync('model-upgrade');
            try {
              const m = await downloadModel((p) => setUpgradeDl({ progress: p }), ac.signal);
              setUpgrade(null);
              onModelReplaced(m);
            } catch (e: any) {
              if (!(e instanceof DownloadCancelled)) Alert.alert('모델 교체 실패', `지금 모델은 그대로입니다.\n${e?.message ?? e}`);
            } finally {
              deactivateKeepAwake('model-upgrade');
              upgradeAbort.current = null;
              setUpgradeDl(null);
            }
          },
        },
      ],
    );
  };

  const busy = streaming !== null || workingWithPhoto;
  const canSend = !!input.trim() || !!pendingImage;

  const updateLibrary = (next: ChatLibraryData, requireSaved = true) => {
    const saved = saveChatLibrary(next);
    if (!saved && requireSaved) {
      Alert.alert('대화를 저장하지 못했어요', '기기 저장 공간을 확인하고 다시 시도해 주세요.');
      return false;
    }
    libraryRef.current = next;
    setLibrary(next);
    return true;
  };

  const setMessages = (update: ChatMessage[] | ((previous: ChatMessage[]) => ChatMessage[])) => {
    const previous = libraryRef.current;
    updateLibrary({ ...previous, chats: previous.chats.map((chat) => chat.id === activeChat.id ? {
      ...chat, messages: typeof update === 'function' ? update(chat.messages) : update, draft: undefined, updatedAt: Date.now(),
    } : chat) }, false);
  };

  const clearPending = () => {
    setPendingImage(null);
    setPendingOcr(null);
    ocrJob.current = null;
  };

  const readOcr = (uri: string) => isOcrAvailable() ? recognizeText(uri).then((r) => r.text).catch(() => null) : Promise.resolve(null);

  /** 사진을 고르면 바로 OCR 을 돌려 둔다 (보통 1초 안팎) */
  const startOcr = (uri: string) => {
    if (!isOcrAvailable()) {
      setPendingOcr(null);
      ocrJob.current = Promise.resolve(null);
      return;
    }
    setPendingOcr(undefined);
    const job = readOcr(uri);
    ocrJob.current = job;
    job.then((t) => {
      if (ocrJob.current === job) setPendingOcr(t);
    });
  };

  const attach = async () => {
    if (workPending.current) return;
    // 이미지 인식(Gemma 비전)이 없어도 OCR 이 있으면 사진의 글자로 답할 수 있다
    if (!isOcrAvailable() && !vision.ensureReady()) return;
    const go = async (src: ImageSource) => {
      if (workPending.current || libraryRef.current.activeId !== activeChat.id) return;
      workPending.current = true;
      setWorkingWithPhoto(true);
      try {
        const uri = await pickImage(src);
        if (uri) {
          setPendingImage(uri);
          startOcr(uri);
        }
      } catch (e: any) {
        Alert.alert('사진', String(e?.message ?? e));
      } finally {
        workPending.current = false;
        setWorkingWithPhoto(false);
      }
    };
    const canScan = await isScanAvailable();
    if (workPending.current || libraryRef.current.activeId !== activeChat.id) return;
    const buttons: AlertButton[] = [
      // 글자만 필요하면: 사진을 찍지 않고 카메라 화면에서 바로 읽는다 (셔터 소리 없음, 사진도 남지 않음)
      ...(canScan ? [{ text: '글자 스캔 (사진 안 찍음)', onPress: () => scanLive() }] : []),
      { text: '카메라로 찍기', onPress: () => go('camera') },
      { text: '앨범에서 고르기', onPress: () => go('library') },
    ];
    // Android 알림창은 버튼이 3개까지라, 4개가 되면 '취소' 대신 바깥을 눌러 닫게 한다
    if (Platform.OS !== 'android' || buttons.length < 3) buttons.push({ text: '취소', style: 'cancel' });
    Alert.alert('사진 첨부', '사진은 이 기기 안에서만 처리됩니다.', buttons, { cancelable: true });
  };

  /** 실시간 글자 스캔: 카메라 화면에서 바로 글자를 읽어 대화에 넣는다 (사진을 찍지 않으므로 셔터 소리 없음) */
  const scanLive = async () => {
    if (workPending.current || libraryRef.current.activeId !== activeChat.id) return;
    workPending.current = true;
    setWorkingWithPhoto(true);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('카메라 권한 필요', '설정에서 이 앱의 카메라 접근을 허용해 주세요.');
        return;
      }
      const text = await scanText();
      if (!text) return; // 취소
      followLatest.current = true;
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'user', content: '📝 글자 스캔' },
        {
          id: uid(),
          role: 'assistant',
          localOcr: true,
          content:
            `**스캔한 글자** (기기 OCR, 길게 눌러 복사)\n\n\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\`\n\n` +
            '번역·요약·설명이 필요하면 이어서 말씀해 주세요.',
        },
      ]);
    } catch (e: any) {
      Alert.alert('글자 스캔', String(e?.message ?? e));
    } finally {
      workPending.current = false;
      setWorkingWithPhoto(false);
    }
  };

  /** 첨부 사진의 글자만 바로 보여 준다 (Gemma 를 거치지 않음) */
  const readTextOnly = async () => {
    if (!pendingImage || workPending.current) return;
    workPending.current = true;
    setWorkingWithPhoto(true);
    const image = pendingImage;
    const text = await (ocrJob.current ?? readOcr(image));
    clearPending();
    followLatest.current = true;
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', content: '📝 사진 속 글자 읽기', image, ...(text ? { ocr: text } : {}) },
      {
        id: uid(),
        role: 'assistant',
        localOcr: true,
        content:
          text == null
            ? '글자를 읽지 못했습니다. 다시 시도해 주세요.'
            : text
              ? `**사진 속 글자** (기기 OCR, 길게 눌러 복사)\n\n\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``
              : '사진에서 글자를 찾지 못했습니다.',
      },
    ]);
    workPending.current = false;
    setWorkingWithPhoto(false);
  };

  const send = async () => {
    const text = input.trim();
    if (!canSend || workPending.current) return;
    // 그림 요청은 모델이 그린 척 하지 않도록 바로 안내한다 (그림 기능은 앱 용량·메모리 부담으로 뺐다)
    if (!pendingImage && DRAW_INTENT.test(text)) {
      followLatest.current = true;
      setInput('');
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'user', content: text },
        {
          id: uid(),
          role: 'assistant',
          content: '이 앱은 그림을 그리지 않아요. 대신 어떤 그림을 그리면 좋을지 구도·색감을 설명하거나, 사진을 보여 주시면 무엇이 있는지 알려 드릴 수 있어요.',
        },
      ]);
      return;
    }
    // 차단이 반복되면 잠시 쉬게 한다
    const wait = cooldownSeconds();
    if (wait > 0) {
      Alert.alert('잠시 후 다시 시도해 주세요', `이용 기준에 맞지 않는 요청이 반복되어 ${wait}초 동안 쉬어 갑니다.`);
      return;
    }
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text || (pendingImage ? '이 사진에 무엇이 있는지 설명하고, 보이는 글자가 있으면 읽어 주세요.' : ''),
      ...(pendingImage ? { image: pendingImage } : {}),
    };
    workPending.current = true;
    let keptAwake = false;
    try {
      if (pendingImage) {
        setWorkingWithPhoto(true);
        const ocr = await (ocrJob.current ?? readOcr(pendingImage));
        if (ocr) userMsg.ocr = ocr;
        if (vision.status.kind !== 'ready' && !ocr && !vision.ensureReady()) return;
        setWorkingWithPhoto(false);
      }
      const history = [...messages, userMsg];
      followLatest.current = true;
      setMessages(history);
      setInput('');
      clearPending();
      setStreaming('요청을 확인하는 중…');
      setStats(null);
      await activateKeepAwakeAsync('gen');
      keptAwake = true;
      await conversationCache.current;
      // 안전 검사는 현재 대화의 최근 요청과 첨부 사진에서 읽은 글자를 함께 확인한다.
      const earlier = messages
        .filter((m) => m.role === 'user' && !m.blocked)
        .slice(-2)
        .map((m) => m.content);
      const checked = userMsg.ocr ? `${userMsg.content}\n[사진 속 글자] ${userMsg.ocr.slice(0, 1500)}` : userMsg.content;
      await checkGeneratedContent(checked, 'user request', earlier);
      // 계산·날짜·단위·기억이 필요해 보이면 기기 도구를 먼저 고르고 실행한 뒤, 그 결과로 답한다
      if (!userMsg.image && mightNeedTool(userMsg.content)) {
        setStreaming('🔧 도구 확인 중…');
        try {
          const call = await pickTool(userMsg.content, messages);
          const result = call ? runTool(call) : null;
          if (result) {
            userMsg.tool = result;
            history[history.length - 1] = { ...userMsg };
            setMessages([...history]);
          }
        } catch (e) {
          console.warn('tool failed', e); // 도구가 실패하면 평소처럼 모델이 답한다
        }
      }
      setStreaming('답변을 준비하는 중…');
      const { text: reply, stats: st } = await generateReply(history, settings);
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: reply || '(빈 응답)' }]);
      setStats(st);
    } catch (e: any) {
      if (e instanceof ContentSafetyError) {
        if (e.category !== 'self_harm') recordStrike(); // 자해 신호는 도움 안내만 하고 벌점은 주지 않는다
        const blocked = e.category !== 'self_harm';
        setMessages((prev) => [
          ...prev.map((m) => (blocked && m.id === userMsg.id ? { ...m, blocked: true } : m)),
          { id: uid(), role: 'assistant', content: e.message },
        ]);
      } else {
        Alert.alert('생성 오류', String(e?.message ?? e));
      }
    } finally {
      if (keptAwake) deactivateKeepAwake('gen');
      workPending.current = false;
      setWorkingWithPhoto(false);
      setStreaming(null);
    }
  };

  const restoreConversation = (target: Conversation) => {
    followLatest.current = true;
    setStats(null);
    setInput(target.draft?.input ?? '');
    clearPending();
    if (target.draft?.image) {
      setPendingImage(target.draft.image);
      startOcr(target.draft.image);
    }
    conversationCache.current = conversationCache.current.then(resetConversationCache).catch(() => {});
  };

  const activateConversation = (next: ChatLibraryData, target: Conversation) => {
    if (workPending.current) return;
    if (activeChat.id !== target.id) {
      const draft = input.trim() || pendingImage ? { input, image: pendingImage } : undefined;
      const chats = next.chats.map((chat) => chat.id === activeChat.id ? { ...chat, draft } : chat);
      if (!updateLibrary({ ...next, chats, activeId: target.id })) return;
      restoreConversation(target);
    }
    Keyboard.dismiss();
    setShowLibrary(false);
  };

  const newChat = (taskId: string | null) => {
    const current = libraryRef.current;
    if (activeChat.taskId === taskId && !hasConversationContent(activeChat) && !input.trim() && !pendingImage) {
      setShowLibrary(false);
      return;
    }
    const next = makeConversation(uid(), taskId);
    activateConversation({ ...current, chats: [...current.chats, next] }, next);
  };

  const createTask = (name: string) => {
    const previous = libraryRef.current;
    const task = { id: uid(), name, done: false };
    if (!workPending.current && updateLibrary({ ...previous, tasks: [...previous.tasks, task] })) setScope(task.id);
  };

  const changeTask = (id: string, change: Partial<Pick<ChatTask, 'name' | 'done'>>) => {
    const previous = libraryRef.current;
    if (!workPending.current) updateLibrary({ ...previous, tasks: previous.tasks.map((task) => task.id === id ? { ...task, ...change } : task) });
  };

  const deleteTask = (id: string) => {
    if (!workPending.current && updateLibrary(removeTask(libraryRef.current, id)) && scope === id) setScope(null);
  };

  const changeChat = (id: string, change: Partial<Pick<Conversation, 'name' | 'pinned' | 'taskId'>>) => {
    const previous = libraryRef.current;
    if (!workPending.current) updateLibrary({ ...previous, chats: previous.chats.map((chat) => chat.id === id ? { ...chat, ...change } : chat) });
  };

  const deleteChat = (id: string) => {
    if (workPending.current) return;
    const previous = libraryRef.current;
    const deletingActive = id === previous.activeId;
    const chats = previous.chats.filter((chat) => chat.id !== id);
    const replacement = deletingActive ? chats.find((chat) => chat.taskId === activeChat.taskId) ?? makeConversation(uid(), activeChat.taskId) : activeChat;
    if (deletingActive && !chats.includes(replacement)) chats.push(replacement);
    if (!updateLibrary({ ...previous, chats, activeId: replacement.id })) return;
    if (deletingActive) restoreConversation(replacement);
    const remainingImages = chats.flatMap((chat) => [chat.draft?.image, ...chat.messages.map((msg) => msg.image)]);
    if (!deletingActive) remainingImages.push(pendingImage);
    try {
      deleteImages(remainingImages.filter((uri): uri is string => !!uri));
      deletePictures(chats.flatMap((chat) => chat.messages.flatMap((msg) => msg.picture ? [msg.picture] : [])));
    } catch (error) {
      console.warn('Could not clean up chat attachments', error);
    }
  };

  const data: ChatMessage[] =
    streaming !== null
      ? [...messages, { id: '__streaming__', role: 'assistant', content: streaming || '…' }]
      : messages;

  const upgradeTransfer = upgradeDl?.progress?.transfer;
  const upgradeDetail = upgradeDl?.progress?.detail ?? (upgradeTransfer
    ? `${formatBytes(upgradeTransfer.received)} / ${formatBytes(upgradeTransfer.total)}`
      + (upgradeTransfer.secondsLeft === undefined ? '' : ` · ${formatDownloadEta(upgradeTransfer.secondsLeft)}`)
    : '');

  const openLibrary = () => {
    Keyboard.dismiss();
    setShowLibrary(true);
  };
  const openSettings = () => setShowSettings(true);
  const openPreview = (media: ImagePreview) => {
    Keyboard.dismiss();
    setPreview(media);
  };
  const scrollToLatest = () => {
    if (followLatest.current && data.length > 0) listRef.current?.scrollToEnd({ animated: false });
  };
  const libraryProps = {
    library, scope, busy,
    onScope: setScope,
    onOpen: (id: string) => {
      const previous = libraryRef.current;
      const target = previous.chats.find((chat) => chat.id === id);
      if (target) activateConversation(previous, target);
    },
    onNew: newChat,
    onTaskCreate: createTask,
    onTaskChange: changeTask,
    onTaskRemove: deleteTask,
    onChatChange: changeChat,
    onChatRemove: deleteChat,
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
            <ChatLibrary {...libraryProps} onSettings={hasDuoToolbar ? undefined : openSettings} />
          </View>
        ) : null}
        <View style={styles.conversation}>
          <View style={splitTranscript ? { height: layout.transcriptHeight, overflow: 'hidden' } : styles.transcript}>
            <View style={styles.header}>
              {!showSidebar && !hasDuoToolbar ? (
                <Pressable accessibilityRole="button" accessibilityLabel="대화와 테스크 메뉴" style={styles.hBtn}
                  onPress={openLibrary}>
                  <Text style={styles.hBtnText}>☰</Text>
                </Pressable>
              ) : null}
              <View style={styles.flex}>
                <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
                  {hasConversationContent(activeChat) ? conversationName(activeChat) : activeTask?.name ?? (hasDuoToolbar ? '새 대화' : APP_NAME)}
                </Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  {activeTask ? `${activeTask.name} · ` : ''}Gemma 3 4B · {gpuInfo}
                  {stats ? ` · ${stats.tokPerSec.toFixed(1)} tok/s` : ''}
                </Text>
              </View>
              {!showSidebar && !hasDuoToolbar ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="새 대화"
                    onPress={() => newChat(activeChat.taskId)}
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
            {upgradeDl ? (
              <View style={styles.dlBar}>
                <View style={styles.flex}>
                  <Text style={styles.dlText} numberOfLines={1}>
                    작은 모델 받는 중 {Math.round((upgradeDl.progress?.ratio ?? 0) * 100)}%
                    {upgradeDetail ? ` · ${upgradeDetail}` : ''}
                  </Text>
                  <View style={styles.dlTrack}>
                    <View style={[styles.dlFill, { width: `${Math.round((upgradeDl.progress?.ratio ?? 0) * 100)}%` }]} />
                  </View>
                </View>
                <Pressable onPress={() => upgradeAbort.current?.abort()} style={styles.hBtn}>
                  <Text style={[styles.hBtnText, { color: colors.danger }]}>취소</Text>
                </Pressable>
              </View>
            ) : null}

            <FlatList
              key={activeChat.id}
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
                    </View>
                  ) : null}
                </View>
              }
              renderItem={({ item }) => (
                <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.botBubble]}>
                  {item.role === 'assistant' && item.picture ? (
                    <PictureCard
                      uri={item.picture}
                      size={mediaSize}
                      caption={item.content.replace(/^\[그림: (.*)\]$/, '$1')}
                      onOpen={(uri) => openPreview({ uri, title: '예전 그림' })}
                    />
                  ) : item.role === 'assistant' && item.svg ? (
                    <Text style={styles.hint}>
                      🖼 예전 버전에서 만든 도형 일러스트입니다. 그림 기능이 빠져 더 이상 표시하지 않습니다.
                    </Text>
                  ) : item.role === 'assistant' ? (
                    <Markdown text={item.content} />
                  ) : (
                    <>
                      {item.image ? (
                        <PhotoThumbnail
                          uri={item.image}
                          label="첨부 사진 크게 보기"
                          style={[styles.msgImage, { width: mediaSize, height: mediaSize }]}
                          onOpen={(uri) => openPreview({ uri, title: '첨부 사진' })}
                        />
                      ) : null}
                      <Text selectable style={[styles.msg, styles.userText]}>{item.content}</Text>
                      {item.tool ? <Text style={styles.toolChip}>{item.tool.chip}</Text> : null}
                    </>
                  )}
                  {SUPPORT_BASE_URL && item.role === 'assistant' && !item.localOcr && !item.picture && !item.svg
                    && !item.id.startsWith('__') && !item.content.startsWith('**사진 속 글자**') ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="이 AI 결과 신고"
                        style={styles.report}
                        onPress={() => setReportItem(item)}
                      >
                        <Text style={styles.reportLabel}>신고</Text>
                      </Pressable>
                    ) : null}
                </View>
              )}
            />
          </View>

          <View style={splitTranscript ? [styles.lowerPane, { marginTop: layout.foldGap }] : styles.composerPane}>
            <View style={styles.composer}>
              {pendingImage ? (
                <View style={styles.pending}>
                  <PhotoThumbnail
                    uri={pendingImage}
                    label="보내기 전 첨부 사진 크게 보기"
                    style={styles.pendingImage}
                    onOpen={(uri) => openPreview({ uri, title: '첨부 사진' })}
                  />
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
                  <Pressable onPress={clearPending} disabled={busy} style={styles.pendingX} accessibilityRole="button" accessibilityLabel="첨부 사진 제거">
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
                    accessibilityRole="button"
                    style={[styles.send, streaming !== null && { backgroundColor: colors.danger }, (workingWithPhoto || (!busy && !canSend)) && styles.off]}
                    onPress={streaming !== null ? stopGeneration : send}
                    disabled={workingWithPhoto || (!busy && !canSend)}
                  >
                    <Text style={styles.sendText}>{streaming !== null ? '중지' : '전송'}</Text>
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
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' && !hasDuoToolbar ? 'padding' : undefined}>
      <DuoToolbar busy={busy} onLibrary={openLibrary} onNewChat={() => newChat(activeChat.taskId)} onSettings={openSettings}>
        <SafeAreaView style={styles.flex}>
          <FoldAwareArea>{renderWorkspace}</FoldAwareArea>
        </SafeAreaView>
      </DuoToolbar>

      {showLibrary ? (
        <Modal onRequestClose={() => setShowLibrary(false)} animationType="slide" presentationStyle="fullScreen">
          <SafeAreaView style={styles.libraryArea}>
            <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <FoldAwareArea>{(size, division) => {
                const insets = getFoldInsets(size, division);
                return (
                  <View style={[styles.flex, { paddingTop: insets.top, paddingRight: insets.right,
                    paddingBottom: insets.bottom, paddingLeft: insets.left }]}>
                    <ChatLibrary {...libraryProps} onClose={() => setShowLibrary(false)} />
                  </View>
                );
              }}</FoldAwareArea>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
      ) : null}

      {reportItem ? <ReportContent item={reportItem} onClose={() => setReportItem(null)} /> : null}

      {preview ? <ImageViewer media={preview} onClose={() => setPreview(null)} /> : null}

      {showSettings ? (
        <SettingsModal
          model={model}
          settings={settings}
          visionStatus={vision.status}
          onDownloadVision={vision.download}
          onRemoveVision={vision.remove}
          upgrade={upgrade}
          upgrading={!!upgradeDl}
          onUpgrade={() => {
            setShowSettings(false);
            startUpgrade();
          }}
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
  upgrade,
  upgrading,
  onUpgrade,
  onClose,
  onSave,
  onRemoveModel,
}: {
  model: InstalledModel;
  settings: Settings;
  visionStatus: VisionStatus;
  onDownloadVision: () => void;
  onRemoveVision: () => void;
  upgrade: ModelUpgrade | null;
  upgrading: boolean;
  onUpgrade: () => void;
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

        <MemorySection visible />

        <StorageSection visible busy={upgrading || visionStatus.kind === 'downloading'} />

        <Text style={[styles.label, { marginTop: 24 }]}>모델</Text>
        <Text style={styles.hint}>
          {model.name} ({formatBytes(model.size)})
        </Text>
        {upgrade || upgrading ? (
          <Pressable
            style={[styles.send, { marginTop: 8 }, upgrading && styles.off]}
            disabled={upgrading}
            onPress={onUpgrade}
          >
            <Text style={styles.sendText}>
              {upgrading ? '작은 모델 받는 중…' : `더 작은 모델로 교체 (−${formatBytes(upgrade!.saving)})`}
            </Text>
          </Pressable>
        ) : null}
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
        <LegalInfo />
      </ScrollView>
    </Modal>
  );
}

/** 설정: 앱이 쓰는 저장 공간 내역 */
/** "기억해 줘" 로 저장한 내용 보기·지우기 */
function MemorySection({ visible }: { visible: boolean }) {
  const [list, setList] = useState(() => loadMemories());
  useEffect(() => {
    if (visible) setList(loadMemories());
  }, [visible]);
  return (
    <View style={{ marginTop: 24, gap: 6 }}>
      <Text style={styles.label}>기억 ({list.length})</Text>
      {list.length === 0 ? (
        <Text style={styles.hint}>채팅에서 "○○ 기억해 줘" 라고 하면 여기에 저장되고, 이후 대화에서 기억합니다. 이 기기 안에만 저장됩니다.</Text>
      ) : (
        <>
          {list.map((m) => (
            <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[styles.hint, styles.flex, { color: colors.text }]}>• {m.text}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${m.text} 지우기`}
                hitSlop={8}
                onPress={() => {
                  removeMemory(m.id);
                  setList(loadMemories());
                }}
              >
                <Text style={[styles.hint, { color: colors.danger }]}>지우기</Text>
              </Pressable>
            </View>
          ))}
          <Pressable
            style={[styles.send, { backgroundColor: colors.border, marginTop: 4 }]}
            onPress={() =>
              Alert.alert('기억 모두 지우기', '저장한 기억을 모두 지웁니다.', [
                { text: '취소', style: 'cancel' },
                {
                  text: '모두 지우기',
                  style: 'destructive',
                  onPress: () => {
                    clearMemories();
                    setList([]);
                  },
                },
              ])
            }
          >
            <Text style={[styles.sendText, { color: colors.text }]}>기억 모두 지우기</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

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

function PhotoThumbnail({ uri, label, style, onOpen }: {
  uri: string;
  label: string;
  style: StyleProp<ImageStyle>;
  onOpen: (uri: string) => void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => onOpen(uri)}>
      <Image source={{ uri }} style={style} resizeMode="cover" />
    </Pressable>
  );
}

/** 예전 버전에서 만든 그림 (그림 기능은 뺐다): 크게 보기만 */
function PictureCard({ uri, size, caption, onOpen }: {
  uri: string;
  size: number;
  caption?: string;
  onOpen: (uri: string) => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <PhotoThumbnail
        uri={uri}
        label="예전 그림 크게 보기"
        style={[styles.picture, { width: size, height: size }]}
        onOpen={onOpen}
      />
      {caption ? <Text style={styles.hint}>{caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  workspace: { flex: 1, flexDirection: 'row' },
  sidebar: {
    borderRightWidth: 1,
    borderRightColor: colors.border,
    overflow: 'hidden',
  },
  libraryArea: { flex: 1, backgroundColor: colors.bg },
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
  toolChip: { marginTop: 6, fontSize: 12, lineHeight: 17, color: 'rgba(255,255,255,0.8)' },
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
  report: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: 10 },
  reportLabel: { color: colors.muted, fontSize: 12 },
  pendingXText: { fontSize: 16, color: colors.muted },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choiceChip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: colors.accentSoft,
  },
  choiceText: { color: colors.accentText, fontSize: 14, fontWeight: '600' },
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

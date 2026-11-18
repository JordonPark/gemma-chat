import { useRef, useState, type ComponentRef } from 'react';
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
  DEFAULT_SETTINGS,
  checkGeneratedContent,
  generateReply,
  pickTool,
  translateLines,
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
import { LeftDrawer } from './LeftDrawer';
import { AnnotatedPhoto } from './AnnotatedPhoto';
import { analysisHeader, analyzePhoto, needsTranslation, type PhotoAnalysis, type PhotoAnnotations } from './photoAnnotate';
import { SOLVE_HEADER, arithmeticNote, isSolveRequest } from './problemSolve';
import { mightNeedTool, runTool } from './tools';
import { getChatLayout, getFoldInsets, minInlineComposerWidth, type Division } from './foldLayout';
import { deletePictures } from './legacyDrawing';
import { ImageViewer, type ImagePreview } from './ImageViewer';
import { ContentSafetyError, cooldownSeconds, recordStrike } from './contentSafety';
import { LegalInfo } from './LegalInfo';
import { ReportContent } from './ReportContent';
import { APP_NAME, SUPPORT_BASE_URL } from './storeConfig';
import type { InstalledModel } from './modelStore';
import { Markdown } from './Markdown';
import { UpdateBanner, checkForUpdateInteractive, describeAppVersion } from './UpdateBanner';
import { loadChatLibrary, saveChatLibrary } from './storage';
import { colors } from './theme';
import { describeVision, useVision, type VisionStatus } from './useVision';
import { deleteImages, pickImage, type ImageSource } from './vision';
import { isOcrAvailable, isScanAvailable, recognizeText, scanText } from '../modules/expo-ocr';
import * as ImagePicker from 'expo-image-picker';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// SwiftUI's navigation stack already lays out the hosted content inside its safe area.
const ChatContentArea = hasDuoToolbar ? View : SafeAreaView;

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

/** 사진 설명이 걸려도 기기 분석 결과조차 보여 주면 안 되는 범주 */
const SEVERE = new Set(['sexual_minors', 'sexual_explicit', 'violence', 'extremism', 'self_harm']);

/** 설정의 "말투": 시스템 프롬프트를 셋 중에서 고른다 (첫 번째는 앱 기본값과 같다) */
const TONE_PRESETS = [
  {
    label: '기본',
    prompt: DEFAULT_SETTINGS.systemPrompt,
    hint: '친절하고 정확하게, 알맞은 길이로 답합니다 (기본값).',
  },
  {
    label: '간단하게',
    prompt: '당신은 친절하고 정확한 AI 비서입니다. 핵심만 짧게 답하세요. 꼭 필요한 경우가 아니면 3문장 이내로 답하고, 여러 항목은 목록으로 정리하세요. 모르는 것은 모른다고 말하세요.',
    hint: '핵심만 짧게 답합니다. 빠르게 확인할 때 좋아요.',
  },
  {
    label: '자세하게',
    prompt: '당신은 친근한 선생님 같은 AI 비서입니다. 쉬운 말로 자세히 설명하고, 필요하면 예시를 들어 단계별로 알려 주세요. 어려운 용어는 풀어서 설명하세요. 모르는 것은 모른다고 말하세요.',
    hint: '선생님처럼 쉬운 말로 자세히, 예시를 들어 설명합니다. 공부할 때 좋아요.',
  },
] as const;

/** 설정의 "답변 스타일": temperature (낮을수록 일정하고 정확, 높을수록 다양하고 창의적) */
const STYLE_PRESETS = [
  { label: '정확하게', temperature: 0.3, hint: '매번 비슷하고 차분한 답. 사실 확인·계산·공부에 알맞습니다.' },
  { label: '균형', temperature: 0.7, hint: '정확함과 자연스러움의 중간입니다.' },
  { label: '창의적으로', temperature: 1.0, hint: '표현이 다양하고 자유로운 답. 글쓰기·아이디어에 알맞습니다 (Gemma 권장 기본값).' },
] as const;

/** 설정의 "대화 길이": 대화 기억 길이(n_ctx)와 한 번에 답하는 최대 길이를 함께 정한다 */
const LENGTH_PRESETS = [
  { label: '적게', nCtx: 2048, maxNewTokens: 512, hint: '짧은 대화·짧은 답. 메모리를 가장 적게 쓰고 가장 빠릅니다.' },
  { label: '중간', nCtx: 4096, maxNewTokens: 1024, hint: '보통 대화에 알맞습니다 (기본값).' },
  { label: '많이', nCtx: 8192, maxNewTokens: 2048, hint: '긴 대화를 더 오래 기억하고 긴 답(풀이·글쓰기)도 끝까지 씁니다. 메모리를 더 쓰고 조금 느려질 수 있어요.' },
] as const;

export function ChatScreen({ settings, gpuInfo, initialInput = '', onChangeSettings }: Props) {
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
  /** 사진 분석(글자 위치 + 물건 위치). 사진마다 한 번만 돌리고 결과를 재사용한다 */
  const annotJob = useRef<{ uri: string; job: Promise<PhotoAnalysis> } | null>(null);
  const analysisFor = (uri: string) => {
    if (annotJob.current?.uri !== uri) annotJob.current = { uri, job: analyzePhoto(uri) };
    return annotJob.current.job;
  };
  const [translatingId, setTranslatingId] = useState<string | null>(null);

  /** 사진을 고르면 바로 OCR·물건 찾기를 돌려 둔다 (보통 1~2초) */
  const startOcr = (uri: string) => {
    if (!isOcrAvailable()) {
      setPendingOcr(null);
      ocrJob.current = Promise.resolve(null);
      return;
    }
    setPendingOcr(undefined);
    const job = analysisFor(uri).then((a) => a.text);
    ocrJob.current = job;
    job.then((t) => {
      if (ocrJob.current === job) setPendingOcr(t);
    });
  };

  /** 사진 속 외국어 줄을 한국어로 번역해 사진 위에 덮어 보여 준다 (답이 끝난 뒤, 모델이 쉬고 있을 때) */
  const translatePhoto = async (msgId: string, annot: PhotoAnnotations) => {
    const idx = annot.lines.map((l, i) => (needsTranslation(l.text) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length || workPending.current) return;
    workPending.current = true;
    setTranslatingId(msgId);
    try {
      const ko = await translateLines(idx.map((i) => annot.lines[i].text));
      if (ko.length === idx.length) {
        const translations: (string | null)[] = annot.lines.map(() => null);
        idx.forEach((li, k) => {
          translations[li] = ko[k] || null;
        });
        setMessages((prev) =>
          prev.map((m) => (m.id === msgId && m.annot ? { ...m, annot: { ...m.annot, translations } } : m)),
        );
      }
    } catch (e) {
      console.warn('photo translation failed', e); // 번역이 안 되면 원문 위치만 보여 준다
    } finally {
      workPending.current = false;
      setTranslatingId(null);
    }
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
    const annot = (await analysisFor(image).catch(() => null))?.annot ?? null;
    const readId = uid();
    clearPending();
    followLatest.current = true;
    setMessages((prev) => [
      ...prev,
      { id: readId, role: 'user', content: '📝 사진 속 글자 읽기', image, ...(text ? { ocr: text } : {}), ...(annot ? { annot } : {}) },
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
    if (annot) translatePhoto(readId, annot);
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
    let answered = false;
    let replyStage = false;
    try {
      if (pendingImage) {
        setWorkingWithPhoto(true);
        const ocr = await (ocrJob.current ?? readOcr(pendingImage));
        if (ocr) userMsg.ocr = ocr;
        const annot = (await analysisFor(pendingImage).catch(() => null))?.annot;
        if (annot) userMsg.annot = annot;
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
      setStreaming(
        isSolveRequest(userMsg.content, !!userMsg.image) ? '문제를 푸는 중…' : userMsg.image ? '사진을 분석하는 중…' : '답변을 준비하는 중…',
      );
      replyStage = true;
      const { text: reply, stats: st } = await generateReply(history, settings);
      // 사진 답은 "분석되었습니다." + 기기에서 찾은 물건·글자 요약으로 시작한다
      // 문제 풀이면 풀이 속 계산을 기기 계산기로 다시 확인해, 다른 곳이 있으면 아래에 알려 준다
      const solving = isSolveRequest(userMsg.content, !!userMsg.image);
      const content = !userMsg.image
        ? reply || '(빈 응답)'
        : solving
          ? `${SOLVE_HEADER}\n\n${reply}${arithmeticNote(reply)}`
          : `${analysisHeader(userMsg.annot)}\n\n${reply}`;
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content }]);
      setStats(st);
      answered = true;
    } catch (e: any) {
      if (e instanceof ContentSafetyError && replyStage && userMsg.image && !SEVERE.has(e.category)) {
        // 사진은 요청 검사는 통과했는데 Gemma 설명만 걸린 경우: 기기 분석 결과(물건·글자 위치)는 그대로 보여 준다
        setMessages((prev) => [
          ...prev,
          {
            id: uid(),
            role: 'assistant',
            content: `${analysisHeader(userMsg.annot)}\n\n사진 위에 찾은 물건과 글자를 표시했어요. 자세한 설명은 이용 기준에 따라 생략했습니다.`,
          },
        ]);
        answered = true;
      } else if (e instanceof ContentSafetyError) {
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
    // 사진에 외국어 글자가 있으면 답이 끝난 뒤 번역해 사진 위에 보여 준다
    if (answered && userMsg.annot) translatePhoto(userMsg.id, userMsg.annot);
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

            <FlatList
              key={activeChat.id}
              ref={listRef}
              style={styles.flex}
              automaticallyAdjustContentInsets={!hasDuoToolbar}
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
                  <Text style={[styles.welcomeTitle, narrow && styles.narrowWelcomeTitle]} accessibilityRole="header">무엇을 도와드릴까요?</Text>
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
                      {item.image && item.annot ? (
                        <AnnotatedPhoto
                          uri={item.image}
                          width={mediaSize}
                          annot={item.annot}
                          translating={translatingId === item.id}
                          onOpen={(uri, view) => openPreview({ uri, title: '첨부 사진', annot: item.annot, ...view })}
                        />
                      ) : item.image ? (
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
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="사진 속 문제 풀기"
                    onPress={() => {
                      // 질문을 직접 써도 되고, 비어 있으면 기본 문장을 넣어 준다 (보내기 전에 고칠 수 있음)
                      if (!input.trim()) setInput('이 문제 풀어 주세요');
                      inputRef.current?.focus();
                    }}
                    style={styles.pendingBtn}
                    disabled={busy}
                  >
                    <Text style={styles.pendingBtnText}>문제 풀기</Text>
                  </Pressable>
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
                  placeholder={pendingImage ? "사진에 대해 물어보세요 (예: 이 문제 풀어줘)" : "메시지 입력"}
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
        <ChatContentArea style={styles.chatContent}>
          <FoldAwareArea>{renderWorkspace}</FoldAwareArea>
        </ChatContentArea>
      </DuoToolbar>

      {/* 대화 목록: 왼쪽에서 밀려 나오는 서랍 */}
      <LeftDrawer visible={showLibrary} onClose={() => setShowLibrary(false)}>
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
      </LeftDrawer>

      {reportItem ? <ReportContent item={reportItem} onClose={() => setReportItem(null)} /> : null}

      {preview ? <ImageViewer media={preview} onClose={() => setPreview(null)} /> : null}

      {showSettings ? (
        <SettingsModal
          settings={settings}
          visionStatus={vision.status}
          onClose={() => setShowSettings(false)}
          onSave={(s) => {
            setShowSettings(false);
            onChangeSettings(s);
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
  settings,
  visionStatus,
  onClose,
  onSave,
}: {
  settings: Settings;
  visionStatus: VisionStatus;
  onClose: () => void;
  onSave: (s: Settings) => void;
}) {
  const [s, setS] = useState(settings);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      supportedOrientations={['portrait', 'landscape']}
    >
      <SafeAreaView style={[styles.flex, styles.settingsBackground]} edges={['top', 'left', 'right']}>
        {/* 제목과 ✕ 는 위에 고정한다 (아래로 스크롤해도 항상 보이게). ✕ 는 바꾼 값을 저장하지 않고 닫는다 */}
        <View style={styles.settingsBar}>
          <Text style={[styles.settingsTitle, styles.flex]}>설정</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="설정 닫기"
            hitSlop={10}
            style={styles.settingsClose}
          >
            <Text style={styles.settingsCloseText}>✕</Text>
          </Pressable>
        </View>
      <ScrollView
        style={styles.settingsBackground}
        contentContainerStyle={styles.settings}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >

        <Text style={styles.label}>말투</Text>
        <View style={styles.segment}>
          {TONE_PRESETS.map((p) => {
            const on = s.systemPrompt.trim() === p.prompt;
            return (
              <Pressable
                key={p.label}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setS({ ...s, systemPrompt: p.prompt })}
                style={[styles.segmentItem, on && styles.segmentOn]}
              >
                <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{p.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>
          {TONE_PRESETS.find((p) => s.systemPrompt.trim() === p.prompt)?.hint ?? '직접 정한 말투를 쓰는 중입니다. 위에서 고르면 바뀝니다.'}
        </Text>

        <Text style={styles.label}>대화 길이</Text>
        <View style={styles.segment}>
          {LENGTH_PRESETS.map((p) => {
            const on = s.nCtx === p.nCtx && s.maxNewTokens === p.maxNewTokens;
            return (
              <Pressable
                key={p.label}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setS({ ...s, nCtx: p.nCtx, maxNewTokens: p.maxNewTokens })}
                style={[styles.segmentItem, on && styles.segmentOn]}
              >
                <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{p.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>
          {(LENGTH_PRESETS.find((p) => p.nCtx === s.nCtx && p.maxNewTokens === s.maxNewTokens)?.hint ??
            `직접 정한 값: 대화 기억 ${s.nCtx} · 답 최대 ${s.maxNewTokens} 토큰`) + ' 바꾸면 모델을 다시 불러옵니다.'}
        </Text>

        <Text style={styles.label}>답변 스타일</Text>
        <View style={styles.segment}>
          {STYLE_PRESETS.map((p) => {
            const on = Math.abs(s.temperature - p.temperature) < 0.05;
            return (
              <Pressable
                key={p.label}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setS({ ...s, temperature: p.temperature })}
                style={[styles.segmentItem, on && styles.segmentOn]}
              >
                <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{p.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>
          {STYLE_PRESETS.find((p) => Math.abs(s.temperature - p.temperature) < 0.05)?.hint ??
            `직접 정한 값 (temperature ${s.temperature}).`}
        </Text>

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

        <View style={{ height: 16 }} />
        <LegalInfo />
      </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/** 설정: 앱이 쓰는 저장 공간 내역 */
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
  chatContent: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.bg },
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
  narrowWelcomeTitle: { fontSize: 25 },
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
  settingsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    width: '100%',
    maxWidth: 648,
    alignSelf: 'center',
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    gap: 4,
    marginTop: 6,
  },
  segmentItem: { flex: 1, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  segmentOn: { backgroundColor: colors.accent },
  segmentText: { fontSize: 15, fontWeight: '600', color: colors.text },
  segmentTextOn: { color: '#fff' },
  settingsClose: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.border,
    marginBottom: 8,
  },
  settingsCloseText: { fontSize: 18, fontWeight: '700', color: colors.text },
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

/**
 * llama.cpp(llama.rn) 위에서 Gemma 3 4B 를 기기 안에서만 실행한다. 네트워크 호출 없음.
 */
import { Platform } from 'react-native';
import { initLlama, type LlamaContext, type RNLlamaOAICompatibleMessage } from 'llama.rn';
import {
  CLASSIFIER_GUIDE,
  ContentSafetyError,
  SAFETY_GUIDE,
  SAFETY_REFUSAL,
  SAFETY_REMINDER,
  SAFETY_SCHEMA,
  parseSafetyCategory,
  quickScreen,
  refusalFor,
  safetySegments,
} from './contentSafety';
import { UNIT_IDS, contextForPrompt, todayLine, type ToolCall } from './tools';
import { LANGUAGE_GUIDE, LANGUAGE_REMINDER, needsKoreanRetry } from './languagePolicy';

export type Role = 'user' | 'assistant';
/**
 * image: 앱 저장소에 있는 사진의 file:// URI (사용자 메시지에만)
 * svg: Gemma 가 그린 일러스트 (어시스턴트 메시지에만). 대화 기록으로 모델에 넘길 때는 content 만 쓴다.
 * ocr: 사진에서 기기 OCR 로 읽은 글자 (사용자 메시지에만)
 */
export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  image?: string;
  svg?: string;
  ocr?: string;
  localOcr?: boolean;
  /** 기기에서 생성한 그림(PNG) file:// URI (어시스턴트 메시지에만) */
  picture?: string;
  /** 채팅에서 고르게 하는 선택지 (예: 그림체). 마지막 메시지일 때만 버튼으로 보인다 */
  choices?: { id: string; label: string }[];
  /** 선택지가 무엇을 위한 것인지 (그림체 질문이면 그릴 내용) */
  choiceFor?: string;
  /** 기기 도구(계산기·날짜·단위·기억)를 쓴 결과 (사용자 메시지에만). note 는 모델에게, chip 은 화면에 */
  tool?: { note: string; chip: string };
  /** 안전 검사에서 막힌 요청 (사용자 메시지에만). 이후 검사·대화 기록에 내용을 넘기지 않는다 */
  blocked?: boolean;
};

const OCR_MAX_CHARS = 2000;
/** OCR 결과를 질문에 붙인다. Gemma 가 직접 읽는 것보다 정확하므로 글자 관련 답은 이걸 우선 쓰게 한다 */
function withOcr(question: string, ocr?: string) {
  if (!ocr?.trim()) return question;
  const t = ocr.trim().slice(0, OCR_MAX_CHARS);
  return (
    `${question}\n\n` +
    `[사진 속 글자 — 기기 OCR 로 읽은 결과입니다. 글자·숫자에 관한 내용은 이 결과를 우선 사용하세요.]\n` +
    `${t}\n[OCR 끝]`
  );
}

export type Settings = {
  systemPrompt: string;
  nCtx: number;
  maxNewTokens: number;
  temperature: number;
  useGpu: boolean;
  /** 이미지 인식 파일이 있으면 불러온다 (메모리가 부족한 기기에서는 끌 수 있음) */
  vision: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  systemPrompt:
    '당신은 친절하고 정확한 AI 비서입니다. 사용자의 언어로 간결하게 답하세요. 모르는 것은 모른다고 말하세요.',
  nCtx: 4096,
  maxNewTokens: 1024,
  temperature: 1.0, // Gemma 3 권장값: temperature 1.0, top_k 64, top_p 0.95, min_p 0.0
  // iOS 는 Metal 이 안정적이므로 기본 사용. Android 는 Adreno(OpenCL) 기기에서만 켜는 것을 권장.
  useGpu: Platform.OS === 'ios',
  vision: true,
};

// 이미지 1장이 차지하는 토큰 수 (Gemma 3: 256) + 여유분
const IMAGE_TOKENS = 300;

// Gemma 3 턴 종료 토큰
const STOP_WORDS = ['<end_of_turn>', '<eos>'];

let ctx: LlamaContext | null = null;
let loadedKey = '';
let visionReady = false;

export const isLoaded = () => ctx != null;
export const isVisionReady = () => visionReady;
export const getContext = () => ctx;

export async function loadModel(
  path: string,
  settings: Settings,
  onProgress?: (pct: number) => void,
): Promise<{ gpu: boolean; reasonNoGPU: string; desc: string }> {
  const key = `${path}|${settings.nCtx}|${settings.useGpu}`;
  if (ctx && loadedKey === key) {
    return { gpu: ctx.gpu, reasonNoGPU: ctx.reasonNoGPU, desc: describe(ctx) };
  }
  await unloadModel();
  ctx = await initLlama(
    {
      model: path,
      n_ctx: settings.nCtx,
      n_batch: 512,
      n_gpu_layers: settings.useGpu ? 99 : 0,
      use_mmap: true,
      use_mlock: false,
      flash_attn_type: 'auto',
      // 이미지(멀티모달)를 쓰려면 꺼야 한다. 대화가 길어지면 fitHistory 가 오래된 메시지를 잘라낸다.
      ctx_shift: false,
    },
    onProgress,
  );
  loadedKey = key;
  visionReady = false;
  return { gpu: ctx.gpu, reasonNoGPU: ctx.reasonNoGPU, desc: describe(ctx) };
}

/** 이미지 인식 켜기 (비전 프로젝터 mmproj 불러오기). 실패하면 이유를 던진다. */
export async function enableVision(mmprojPath: string, useGpu: boolean): Promise<void> {
  const c = ctx;
  if (!c) throw new Error('모델이 로드되지 않았습니다.');
  if (visionReady) return;
  const ok = await c.initMultimodal({ path: mmprojPath, use_gpu: useGpu });
  if (!ok) throw new Error('이미지 인식 파일을 불러오지 못했습니다.');
  const support = await c.getMultimodalSupport();
  if (!support.vision) throw new Error('이 모델 파일은 이미지 인식을 지원하지 않습니다.');
  visionReady = true;
}

export async function disableVision() {
  if (ctx && visionReady) await ctx.releaseMultimodal();
  visionReady = false;
}

function describe(c: LlamaContext): string {
  const m = c.model as unknown as { desc?: string; nParams?: number } | undefined;
  return m?.desc ?? 'loaded';
}

export async function unloadModel() {
  const c = ctx;
  ctx = null;
  loadedKey = '';
  visionReady = false;
  if (c) await c.release();
}

export async function stopGeneration() {
  if (ctx) await ctx.stopCompletion();
}

export async function resetConversationCache() {
  if (ctx) await ctx.clearCache(false);
}

/** 컨텍스트 창에 들어가도록 오래된 메시지부터 잘라낸다 (토큰 수는 실제 토크나이저로 계산) */
async function fitHistory(c: LlamaContext, history: ChatMessage[], budget: number): Promise<ChatMessage[]> {
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const n =
      (await c.tokenize(history[i].content)).tokens.length +
      8 + // 턴 구분 토큰 여유분
      (history[i].image ? IMAGE_TOKENS : 0) +
      (history[i].tool ? 60 : 0) +
      (history[i].ocr ? Math.min(history[i].ocr!.length, OCR_MAX_CHARS) : 0); // OCR 글자 (한글은 대략 글자당 1토큰)
    if (used + n > budget && kept.length > 0) break;
    kept.unshift(history[i]);
    used += n;
  }
  // Gemma 템플릿은 user 로 시작해야 한다
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

export type GenStats = { tokens: number; tokPerSec: number; interrupted: boolean };

export async function generateReply(
  history: ChatMessage[],
  settings: Settings,
): Promise<{ text: string; stats: GenStats }> {
  const c = ctx;
  if (!c) throw new Error('모델이 로드되지 않았습니다.');

  // 시스템 프롬프트 = 안전 기준 + 언어 규칙 + 사용자 설정 + 오늘 날짜 + 기억해 둔 내용 + 안전·언어 재확인
  // (사용자 프롬프트·기억에 "규칙 무시" 같은 말이 있어도 안전 기준이 앞뒤에서 우선한다)
  const system = [SAFETY_GUIDE, LANGUAGE_GUIDE, settings.systemPrompt.trim(), contextForPrompt(), SAFETY_REMINDER, LANGUAGE_REMINDER]
    .filter(Boolean)
    .join('\n\n');
  const sysTokens = (await c.tokenize(system)).tokens.length;
  const budget = Math.max(256, settings.nCtx - settings.maxNewTokens - sysTokens - 64);
  const turns = await fitHistory(c, history, budget);

  // 사진은 가장 최근 사진 1장만 실제로 넣는다 (이전 사진까지 매번 다시 보면 느려진다)
  // 이미지 인식이 꺼져 있으면: 새 메시지의 사진은 OCR 글자로만 답하고, OCR 도 없으면 안내한다. 예전 사진은 "[사진]" 글자로 대신한다
  const lastTurn = turns[turns.length - 1];
  if (!visionReady && lastTurn?.image && !lastTurn.ocr?.trim()) {
    throw new Error('이미지 인식이 꺼져 있고 사진에서 글자도 찾지 못했습니다. 설정에서 이미지 인식을 켜거나 이미지 인식 파일을 받아 주세요.');
  }
  const lastImageIdx = visionReady ? turns.map((m) => !!m.image).lastIndexOf(true) : -1;
  const messages: RNLlamaOAICompatibleMessage[] = [
    { role: 'system', content: system },
    ...turns.map((m, i): RNLlamaOAICompatibleMessage => {
      if (m.image && i === lastImageIdx) {
        return {
          role: m.role,
          content: [
            { type: 'image_url', image_url: { url: m.image } },
            { type: 'text', text: withOcr(m.content || '이 사진을 설명해 주세요.', m.ocr) },
          ],
        };
      }
      if (m.image && i === turns.length - 1) {
        // 이미지 인식 없이 OCR 글자만으로 답하는 경우
        return { role: m.role, content: withOcr(`[사진 첨부 — 이미지는 볼 수 없고 글자만 제공됩니다] ${m.content}`, m.ocr) };
      }
      // 그려 준 그림은 "[그림: …]" 형식을 그대로 넘기면 모델이 그 글자를 흉내 내므로 평범한 문장으로 바꿔 넘긴다
      if (m.picture || m.svg) {
        const what = m.content.replace(/^\[그림: (.*)\]$/, '$1');
        return { role: m.role, content: `(앱이 "${what}" 그림을 그려서 보여 줬습니다.)` };
      }
      if (m.blocked) return { role: m.role, content: '(이용 기준에 맞지 않아 답하지 않은 요청)' };
      const body = m.image ? `[사진] ${m.content}` : m.content;
      // 기기 도구 결과: 모델이 직접 계산하지 말고 이 값을 쓰게 한다
      if (m.tool) return { role: m.role, content: `${body}\n\n(앱 도구 결과 — 이 값을 그대로 믿고 답하세요: ${m.tool.note})` };
      return { role: m.role, content: body };
    }),
  ];

  const run = async (msgs: RNLlamaOAICompatibleMessage[]) => {
    let acc = '';
    const r = await c.completion(
      {
        messages: msgs,
        jinja: true,
        n_predict: settings.maxNewTokens,
        temperature: settings.temperature,
        top_k: 64,
        top_p: 0.95,
        min_p: 0.0,
        penalty_repeat: 1.0,
        stop: STOP_WORDS,
      },
      (data) => {
        acc += data.token;
      },
    );
    return { res: r, text: stripStop(r.content || r.text || acc).trim() };
  };

  let { res, text } = await run(messages);
  // 언어 가드레일: 번역·외국어 요청이 아닌데 답이 대부분 외국어면, 한국어로 답하라고 덧붙여 한 번 다시 만든다
  const request = lastTurn?.content ?? '';
  if (!res.interrupted && needsKoreanRetry(text, request, !!(lastTurn?.image || lastTurn?.ocr))) {
    // 컨텍스트가 넘치지 않게, 앞 답을 덧붙이지 않고 마지막 질문에 한 줄만 더해 다시 만든다
    const last = messages[messages.length - 1];
    const note = '\n\n(한국어로 답해 주세요. 코드·고유명사는 그대로 두어도 됩니다.)';
    const retryLast: RNLlamaOAICompatibleMessage =
      typeof last.content === 'string'
        ? { ...last, content: last.content + note }
        : { ...last, content: [...(last.content as any[]), { type: 'text', text: note }] };
    const again = await run([...messages.slice(0, -1), retryLast]);
    if (!again.res.interrupted && again.text) ({ res, text } = again);
  }
  if (res.interrupted) text = '답변 생성을 중단했습니다.';
  if (!res.interrupted) await checkGeneratedContent(text, 'assistant reply');
  return {
    text,
    stats: {
      tokens: res.timings?.predicted_n ?? 0,
      tokPerSec: res.timings?.predicted_per_second ?? 0,
      interrupted: !!res.interrupted,
    },
  };
}

/**
 * 요청·답변 안전 검사. 정책을 통과하기 전에는 생성 결과를 표시하지 않는다.
 *  1) 요청은 정규식 1차 검사(빠르고 우회에 강함)
 *  2) 모델 분류기: 범주 하나를 고른다. earlier = 최근 사용자 말 (나눠서 묻는 우회 방지)
 * 걸리면 범주에 맞는 안내 문구로 ContentSafetyError. 분류 결과를 읽지 못하면 막는다(fail-closed).
 */
export async function checkGeneratedContent(
  text: string,
  kind: 'user request' | 'assistant reply',
  earlier: string[] = [],
): Promise<void> {
  const c = ctx;
  if (!c) throw new Error('모델이 로드되지 않았습니다.');
  if (kind === 'user request') {
    // 이번 말만, 그리고 바로 앞 말과 이어서(나눠서 묻는 경우) 본다
    const prev = earlier[earlier.length - 1];
    const hit = quickScreen(text) ?? (prev && !quickScreen(prev) ? quickScreen(`${prev}\n${text}`) : null);
    if (hit && hit !== 'safe') throw new ContentSafetyError(refusalFor(hit), hit);
  }
  const segments = safetySegments(text);
  if (!segments.length) return;

  const replyNote =
    kind === 'assistant reply'
      ? 'This is an assistant reply. Choose safe if it refuses, warns, gives prevention or support resources, or general non-harmful information; flag it only if it actually contains harmful content.'
      : 'This is a user request. Flag it if fulfilling it would require harmful content.';
  await c.clearCache(false);
  try {
    for (const segment of segments) {
      const input = JSON.stringify({
        kind,
        earlier_user_turns: earlier.map((e) => e.slice(0, 300)),
        content: segment,
      }).replace(/[<>]/g, (mark) => (mark === '<' ? '\\u003c' : '\\u003e'));
      const result = await c.completion({
        messages: [
          { role: 'system', content: `${CLASSIFIER_GUIDE}\n${replyNote}\nReturn only JSON {"category": ...}.` },
          { role: 'user', content: input },
        ],
        jinja: true,
        n_predict: 24,
        temperature: 0,
        stop: STOP_WORDS,
        response_format: { type: 'json_schema', json_schema: { strict: true, schema: SAFETY_SCHEMA } },
      });
      if (result.interrupted) throw new ContentSafetyError('콘텐츠 검사를 중단했습니다.');
      const cat = parseSafetyCategory(stripStop(result.content || result.text || ''));
      if (cat === null) throw new ContentSafetyError(SAFETY_REFUSAL);
      if (cat !== 'safe') throw new ContentSafetyError(refusalFor(cat), cat);
    }
  } finally {
    await c.clearCache(false);
  }
}

function stripStop(s: string) {
  let out = s;
  for (const w of STOP_WORDS) {
    const i = out.indexOf(w);
    if (i >= 0) out = out.slice(0, i);
  }
  return out;
}

// ───────────────────────── 기기 도구 고르기 (계산기·날짜·단위 변환·기억)

const TOOL_SCHEMA = {
  anyOf: [
    { type: 'object', properties: { tool: { const: 'none' } }, required: ['tool'], additionalProperties: false },
    {
      type: 'object',
      properties: { tool: { const: 'calculator' }, expression: { type: 'string' } },
      required: ['tool', 'expression'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        tool: { const: 'date' },
        op: { enum: ['now', 'add', 'diff', 'weekday'] },
        date: { type: 'string' },
        days: { type: 'integer' },
        target: { type: 'string' },
      },
      required: ['tool', 'op', 'date', 'days', 'target'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { tool: { const: 'convert' }, value: { type: 'number' }, from: { enum: UNIT_IDS }, to: { enum: UNIT_IDS } },
      required: ['tool', 'value', 'from', 'to'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { tool: { const: 'remember' }, text: { type: 'string' } },
      required: ['tool', 'text'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { tool: { const: 'forget' }, text: { type: 'string' } },
      required: ['tool', 'text'],
      additionalProperties: false,
    },
  ],
};

const TOOL_GUIDE = [
  'You route a chat message to an on-device tool. Output JSON only.',
  'Tools:',
  '- calculator {expression}: any arithmetic the answer needs (use + - * / ^ % ( ) sqrt). Turn words into math, e.g. "3만원의 15% 할인" -> "30000*(1-0.15)".',
  '- date {op, date, days, target}: op "now" = current time; "add" = date plus days (negative for before; weeks*7, months ~ use calendar days); "diff" = days from date to target; "weekday" = weekday of date. Dates as YYYY-MM-DD, empty string means today. Unused fields: "" or 0.',
  '- convert {value, from, to}: unit conversion. Units: ' + UNIT_IDS.join(', ') + ' (C/F/K = temperature, 평 = pyeong area).',
  '- remember {text}: the user explicitly asks you to remember/save a fact. text = the fact, short, in the user\'s language.',
  '- forget {text}: the user asks you to forget something. text = keywords of what to forget.',
  '- none: anything else (general questions, chatting, math already done, recalling remembered facts).',
  'Examples:',
  '"1234 곱하기 5678은?" -> {"tool":"calculator","expression":"1234*5678"}',
  '"크리스마스까지 며칠 남았어?" -> {"tool":"date","op":"diff","date":"","days":0,"target":"<this year>-12-25"}',
  '"100일 뒤는 언제야" -> {"tool":"date","op":"add","date":"","days":100,"target":""}',
  '"지금 몇 시야" -> {"tool":"date","op":"now","date":"","days":0,"target":""}',
  '"30평은 몇 제곱미터?" -> {"tool":"convert","value":30,"from":"평","to":"m2"}',
  '"화씨 100도는 섭씨로?" -> {"tool":"convert","value":100,"from":"F","to":"C"}',
  '"내 생일은 5월 3일이야, 기억해 줘" -> {"tool":"remember","text":"사용자 생일: 5월 3일"}',
  '"내 생일 언제라고 했지?" -> {"tool":"none"}',
].join('\n');

/**
 * 메시지에 기기 도구가 필요한지 모델에게 짧게 물어 고른다 (JSON 스키마로 형식 강제).
 * prev: 바로 앞 대화 (예: "그럼 화씨로는?" 처럼 앞 내용을 가리키는 질문용)
 */
export async function pickTool(text: string, prev: ChatMessage[]): Promise<ToolCall | null> {
  const c = ctx;
  if (!c) return null;
  const recent = prev
    .slice(-2)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`)
    .join('\n');
  const res = await c.completion({
    messages: [
      {
        role: 'user',
        content: [
          TOOL_GUIDE,
          '',
          todayLine(),
          ...(recent ? ['Recent conversation:', recent] : []),
          '',
          `Message: ${text}`,
        ].join('\n'),
      },
    ],
    jinja: true,
    n_predict: 120,
    temperature: 0,
    stop: STOP_WORDS,
    response_format: { type: 'json_schema', json_schema: { strict: true, schema: TOOL_SCHEMA } },
  });
  try {
    const call = JSON.parse(stripStop(res.content || res.text || '').trim()) as ToolCall;
    return call?.tool && call.tool !== 'none' ? call : null;
  } catch {
    return null;
  }
}

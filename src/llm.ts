/**
 * llama.cpp(llama.rn) 위에서 Gemma 3 4B 를 기기 안에서만 실행한다. 네트워크 호출 없음.
 */
import { Platform } from 'react-native';
import { initLlama, type LlamaContext, type RNLlamaOAICompatibleMessage } from 'llama.rn';
import { closePartialSvg, extractSvg, illustrationPrompt, sanitizeSvg } from './svg';

export type Role = 'user' | 'assistant';
/**
 * image: 앱 저장소에 있는 사진의 file:// URI (사용자 메시지에만)
 * svg: Gemma 가 그린 일러스트 (어시스턴트 메시지에만). 대화 기록으로 모델에 넘길 때는 content 만 쓴다.
 * ocr: 사진에서 기기 OCR 로 읽은 글자 (사용자 메시지에만)
 */
export type ChatMessage = { id: string; role: Role; content: string; image?: string; svg?: string; ocr?: string };

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
  onText: (textSoFar: string) => void,
): Promise<{ text: string; stats: GenStats }> {
  const c = ctx;
  if (!c) throw new Error('모델이 로드되지 않았습니다.');

  const sysTokens = (await c.tokenize(settings.systemPrompt)).tokens.length;
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
    ...(settings.systemPrompt.trim() ? [{ role: 'system', content: settings.systemPrompt.trim() }] : []),
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
      return { role: m.role, content: m.image ? `[사진] ${m.content}` : m.content };
    }),
  ];

  let acc = '';
  const res = await c.completion(
    {
      messages,
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
      onText(stripStop(acc));
    },
  );

  const text = stripStop(res.content || res.text || acc).trim();
  return {
    text,
    stats: {
      tokens: res.timings?.predicted_n ?? 0,
      tokPerSec: res.timings?.predicted_per_second ?? 0,
      interrupted: !!res.interrupted,
    },
  };
}

function stripStop(s: string) {
  let out = s;
  for (const w of STOP_WORDS) {
    const i = out.indexOf(w);
    if (i >= 0) out = out.slice(0, i);
  }
  return out;
}

// ───────────────────────── 일러스트 (SVG) ─────────────────────────

/**
 * 설명을 받아 Gemma 가 SVG 일러스트를 그린다. 그리는 중간중간 onPartial 로 그릴 수 있는 SVG 를 넘겨 준다.
 * 대화 기록과 섞이지 않게 단독 요청으로 처리한다.
 */
export async function generateIllustration(
  description: string,
  onPartial: (svg: string | null, rawLength: number) => void,
): Promise<{ svg: string; stats: GenStats }> {
  const c = ctx;
  if (!c) throw new Error('모델이 로드되지 않았습니다.');

  await c.clearCache(false);
  let acc = '';
  let lastEmit = 0;
  const res = await c.completion(
    {
      messages: [{ role: 'user', content: illustrationPrompt(description) }],
      jinja: true,
      n_predict: 2600,
      temperature: 0.55, // 낮을수록 계획대로 차분하게 그린다
      top_k: 64,
      top_p: 0.95,
      stop: [...STOP_WORDS, '</svg>'],
    },
    (data) => {
      acc += data.token;
      const now = Date.now();
      if (now - lastEmit < 400) return; // 미리보기는 0.4초마다
      lastEmit = now;
      const p = closePartialSvg(acc);
      onPartial(p ? sanitizeSvg(p) : null, acc.length);
    },
  );
  await c.clearCache(false);

  let raw = stripStop(res.content || res.text || acc);
  if (!/<\/svg>/i.test(raw)) raw += '</svg>'; // stop 단어로 잘린 닫는 태그 복구
  const svg = extractSvg(raw);
  if (!svg) throw new Error('그림을 만들지 못했습니다. 설명을 조금 바꿔 다시 시도해 보세요.');
  const closed = closePartialSvg(svg) ?? svg;
  return {
    svg: sanitizeSvg(closed),
    stats: {
      tokens: res.timings?.predicted_n ?? 0,
      tokPerSec: res.timings?.predicted_per_second ?? 0,
      interrupted: !!res.interrupted,
    },
  };
}

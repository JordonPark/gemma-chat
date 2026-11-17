/**
 * llama.cpp(llama.rn) 위에서 Gemma 3 4B 를 기기 안에서만 실행한다. 네트워크 호출 없음.
 */
import { Platform } from 'react-native';
import { initLlama, type LlamaContext, type RNLlamaOAICompatibleMessage } from 'llama.rn';

export type Role = 'user' | 'assistant';
/** image: 앱 저장소에 있는 사진의 file:// URI (사용자 메시지에만) */
export type ChatMessage = { id: string; role: Role; content: string; image?: string };

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
      (await c.tokenize(history[i].content)).tokens.length + 8 + (history[i].image ? IMAGE_TOKENS : 0); // 턴 구분 토큰 여유분
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
  // 이미지 인식이 꺼져 있으면: 새로 보낸 메시지에 사진이 있을 때만 오류, 예전 사진은 "[사진]" 글자로 대신한다
  if (!visionReady && turns[turns.length - 1]?.image) {
    throw new Error('이미지 인식이 꺼져 있습니다. 설정에서 이미지 인식을 켜거나 이미지 인식 파일을 받아 주세요.');
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
            { type: 'text', text: m.content || '이 사진을 설명해 주세요.' },
          ],
        };
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

// ───────────────────────── 사진 인증 ─────────────────────────

export type VerifyVerdict = 'PASS' | 'FAIL' | 'UNSURE';
export type VerifyResult = {
  verdict: VerifyVerdict;
  /** 사진에서 본 것 (물체 위주 짧은 설명) */
  seen: string;
  /** 사진에서 읽은 글자 (없으면 빈 문자열) */
  text: string;
  /** 판정 이유 */
  reason: string;
};

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'UNSURE'] },
    seen: { type: 'string' },
    text: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'seen', 'text', 'reason'],
};

/**
 * 사진이 조건(물체·글자)을 만족하는지 판정한다.
 * 답은 JSON 스키마로 강제해서 PASS / FAIL / UNSURE 중 하나로만 받는다.
 */
export async function verifyImage(imageUri: string, condition: string): Promise<VerifyResult> {
  const c = ctx;
  if (!c) throw new Error('모델이 로드되지 않았습니다.');
  if (!visionReady) throw new Error('이미지 인식이 준비되지 않았습니다.');

  const prompt =
    `당신은 사진 인증 심사원입니다. 사진이 아래 "인증 조건"을 만족하는지 엄격하게 판단하세요.\n\n` +
    `인증 조건: ${condition.trim()}\n\n` +
    `규칙:\n` +
    `- 조건의 물체나 글자가 사진에 분명히 보이면 PASS.\n` +
    `- 보이지 않거나 다른 물체·다른 글자면 FAIL.\n` +
    `- 사진이 흐리거나 가려져서 확신할 수 없으면 UNSURE.\n` +
    `- 글자 조건은 사진에서 실제로 읽은 글자와 비교하세요. 추측해서 글자를 만들어 내지 마세요.\n` +
    `- seen: 사진에 보이는 주요 물체를 한국어로 짧게. text: 사진에서 읽을 수 있는 글자를 그대로(없으면 ""). reason: 판정 이유를 한국어 한두 문장으로.`;

  // 이전 대화의 캐시가 섞이지 않도록 비우고 시작
  await c.clearCache(false);
  const res = await c.completion({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUri } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    jinja: true,
    n_predict: 400,
    temperature: 0.1,
    top_k: 40,
    top_p: 0.9,
    stop: STOP_WORDS,
    response_format: { type: 'json_schema', json_schema: { strict: true, schema: VERIFY_SCHEMA } },
  });
  await c.clearCache(false);

  const raw = stripStop(res.content || res.text || '').trim();
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const verdict: VerifyVerdict = ['PASS', 'FAIL', 'UNSURE'].includes(j.verdict) ? j.verdict : 'UNSURE';
    return { verdict, seen: String(j.seen ?? ''), text: String(j.text ?? ''), reason: String(j.reason ?? '') };
  } catch {
    return { verdict: 'UNSURE', seen: '', text: '', reason: `모델 답을 해석하지 못했습니다: ${raw.slice(0, 200)}` };
  }
}

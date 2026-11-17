/**
 * llama.cpp(llama.rn) 위에서 Gemma 3 4B 를 기기 안에서만 실행한다. 네트워크 호출 없음.
 */
import { Platform } from 'react-native';
import { initLlama, type LlamaContext } from 'llama.rn';

export type Role = 'user' | 'assistant';
export type ChatMessage = { id: string; role: Role; content: string };

export type Settings = {
  systemPrompt: string;
  nCtx: number;
  maxNewTokens: number;
  temperature: number;
  useGpu: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  systemPrompt:
    '당신은 친절하고 정확한 AI 비서입니다. 사용자의 언어로 간결하게 답하세요. 모르는 것은 모른다고 말하세요.',
  nCtx: 4096,
  maxNewTokens: 1024,
  temperature: 1.0, // Gemma 3 권장값: temperature 1.0, top_k 64, top_p 0.95, min_p 0.0
  // iOS 는 Metal 이 안정적이므로 기본 사용. Android 는 Adreno(OpenCL) 기기에서만 켜는 것을 권장.
  useGpu: Platform.OS === 'ios',
};

// Gemma 3 턴 종료 토큰
const STOP_WORDS = ['<end_of_turn>', '<eos>'];

let ctx: LlamaContext | null = null;
let loadedKey = '';

export const isLoaded = () => ctx != null;
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
      ctx_shift: true,
    },
    onProgress,
  );
  loadedKey = key;
  return { gpu: ctx.gpu, reasonNoGPU: ctx.reasonNoGPU, desc: describe(ctx) };
}

function describe(c: LlamaContext): string {
  const m = c.model as unknown as { desc?: string; nParams?: number } | undefined;
  return m?.desc ?? 'loaded';
}

export async function unloadModel() {
  const c = ctx;
  ctx = null;
  loadedKey = '';
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
    const n = (await c.tokenize(history[i].content)).tokens.length + 8; // 턴 구분 토큰 여유분
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

  const messages = [
    ...(settings.systemPrompt.trim() ? [{ role: 'system', content: settings.systemPrompt.trim() }] : []),
    ...turns.map((m) => ({ role: m.role, content: m.content })),
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

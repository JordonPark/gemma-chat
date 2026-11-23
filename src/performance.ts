import { Platform } from 'react-native';
import { ANDROID_COMPACT_MEMORY_BYTES, deviceMemoryBytes } from './deviceCheck';
import type { Settings } from './llm';

export const LIGHT_CHAT_SETTINGS = { nCtx: 2048, maxNewTokens: 512, useGpu: false } as const;

export const PERFORMANCE_LEVELS = {
  efficiency: {
    label: '효율', nCtx: LIGHT_CHAT_SETTINGS.nCtx, maxNewTokens: LIGHT_CHAT_SETTINGS.maxNewTokens,
    hint: '짧은 대화와 답변에 알맞고 RAM 사용량을 줄여요.',
  },
  balanced: {
    label: '균형', nCtx: 4096, maxNewTokens: 1024,
    hint: '일상적인 대화에 충분한 문맥 길이를 사용해요.',
  },
  high: {
    label: '고성능', nCtx: 8192, maxNewTokens: 2048,
    hint: '더 긴 대화와 답변을 지원하며 RAM을 더 써요.',
  },
} as const;

export const PERFORMANCE_ORDER = ['efficiency', 'balanced', 'high'] as const;
export type PerformanceLevel = keyof typeof PERFORMANCE_LEVELS;
export type PerformanceMode = 'auto' | PerformanceLevel;

// Reported physical RAM is below the advertised capacity on many phones.
const BALANCED_MIN_MEMORY = 7 * 1024 ** 3;
const HIGH_MIN_MEMORY = 11 * 1024 ** 3;

export function recommendPerformance(memory = deviceMemoryBytes(), os = Platform.OS): PerformanceLevel {
  if (memory === null || (os === 'android' && memory <= ANDROID_COMPACT_MEMORY_BYTES)
      || memory < BALANCED_MIN_MEMORY) return 'efficiency';
  return memory >= HIGH_MIN_MEMORY ? 'high' : 'balanced';
}

export function applyPerformanceMode(settings: Settings, mode: PerformanceMode): Settings {
  const level = mode === 'auto' ? recommendPerformance() : mode;
  const profile = PERFORMANCE_LEVELS[level];
  return {
    ...settings,
    performanceMode: mode,
    nCtx: profile.nCtx,
    maxNewTokens: profile.maxNewTokens,
    // Android OpenCL compatibility varies by chipset and driver. It stays opt-in.
    useGpu: level !== 'efficiency' && Platform.OS === 'ios',
  };
}

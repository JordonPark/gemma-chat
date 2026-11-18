/** 설정 / 대화 내용을 기기 안의 JSON 파일로 저장 (오프라인) */
import { File, Paths } from 'expo-file-system';
import { DEFAULT_SETTINGS, type ChatMessage, type Settings } from './llm';

const settingsFile = () => new File(Paths.document, '.settings.json');
const chatFile = () => new File(Paths.document, '.chat.json');

function readJson<T>(f: File, fallback: T): T {
  try {
    if (!f.exists) return fallback;
    return JSON.parse(f.textSync()) as T;
  } catch {
    return fallback;
  }
}

function writeJson(f: File, v: unknown) {
  try {
    if (!f.exists) f.create();
    f.writeSync(JSON.stringify(v));
  } catch (e) {
    console.warn('save failed', e);
  }
}

export const loadSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) });
export const saveSettings = (s: Settings) => writeJson(settingsFile(), s);

export const loadChat = (): ChatMessage[] => readJson(chatFile(), [] as ChatMessage[]);
export const saveChat = (m: ChatMessage[]) => writeJson(chatFile(), m);

const termsFile = () => new File(Paths.document, '.model-terms-v1.json');

export const hasAcceptedModelTerms = () => readJson(termsFile(), false);
export function acceptModelTerms() {
  const file = termsFile();
  if (!file.exists) file.create();
  file.writeSync('true');
}

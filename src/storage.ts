/** 설정 / 대화 내용을 기기 안의 JSON 파일로 저장 (오프라인) */
import { File, Paths } from 'expo-file-system';
import { makeConversation, type ChatLibraryData } from './conversationLibrary';
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

const libraryFile = () => new File(Paths.document, '.chat-library.json');
const nextLibraryFile = () => new File(Paths.document, '.chat-library.next.json');

export function loadChatLibrary(): ChatLibraryData {
  for (const file of [libraryFile(), nextLibraryFile()]) {
    const library = readJson<ChatLibraryData | null>(file, null);
    if (Array.isArray(library?.chats) && Array.isArray(library.tasks)
        && library.chats.some((chat) => chat.id === library.activeId)) return library;
  }
  const legacy = readJson<ChatMessage[]>(chatFile(), []);
  const chat = { ...makeConversation('first-chat', null), messages: Array.isArray(legacy) ? legacy : [] };
  return { activeId: chat.id, tasks: [], chats: [chat] };
}

export function saveChatLibrary(library: ChatLibraryData): boolean {
  // If a save was interrupted during the rename, first restore the completed file.
  const target = libraryFile();
  try {
    const next = nextLibraryFile();
    if (!target.exists && readJson<ChatLibraryData | null>(next, null)?.chats?.length) next.moveSync(target);
    const staged = nextLibraryFile();
    if (!staged.exists) staged.create();
    staged.writeSync(JSON.stringify(library));
    staged.moveSync(target, { overwrite: true });
  } catch (error) {
    console.warn('Could not save chat library', error);
    return false;
  }
  try {
    const legacy = chatFile();
    if (legacy.exists) legacy.delete();
  } catch (error) {
    console.warn('Could not remove migrated chat file', error);
  }
  return true;
}

const termsFile = () => new File(Paths.document, '.model-terms-v1.json');

export const hasAcceptedModelTerms = () => readJson(termsFile(), false);
export function acceptModelTerms() {
  const file = termsFile();
  if (!file.exists) file.create();
  file.writeSync('true');
}

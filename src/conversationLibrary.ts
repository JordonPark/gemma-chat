import type { ChatMessage } from './llm';

export type ChatTask = { id: string; name: string; done: boolean };
export type ChatDraft = { input: string; image: string | null };
export type Conversation = {
  id: string;
  taskId: string | null;
  name?: string;
  pinned?: boolean;
  draft?: ChatDraft;
  updatedAt: number;
  messages: ChatMessage[];
};
export type ChatLibraryData = { activeId: string; tasks: ChatTask[]; chats: Conversation[] };

export const makeConversation = (id: string, taskId: string | null): Conversation => ({
  id, taskId, updatedAt: Date.now(), messages: [],
});

export function conversationName(chat: Conversation): string {
  if (chat.name) return chat.name;
  const firstQuestion = chat.messages.find((message) => message.role === 'user' && message.content.trim());
  return (firstQuestion?.content ?? chat.draft?.input)?.trim().replace(/\s+/g, ' ').slice(0, 60) || '새 대화';
}

export const hasConversationContent = (chat: Conversation) =>
  !!(chat.messages.length || chat.name || chat.pinned || chat.draft?.input.trim() || chat.draft?.image);

export function removeTask(library: ChatLibraryData, taskId: string): ChatLibraryData {
  return {
    ...library,
    tasks: library.tasks.filter((task) => task.id !== taskId),
    chats: library.chats.map((chat) => chat.taskId === taskId ? { ...chat, taskId: null } : chat),
  };
}

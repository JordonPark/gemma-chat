import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { conversationName, hasConversationContent, type ChatLibraryData, type ChatTask, type Conversation } from './conversationLibrary';
import { APP_NAME } from './storeConfig';
import { colors } from './theme';

// undefined: all chats, null: unassigned, string: a specific task
export type ChatScope = string | null | undefined;
type Menu = { kind: 'task' | 'chat' | 'move'; id: string };
type Editor = { kind: 'new' | 'task' | 'chat'; id?: string; name: string };

type Props = {
  library: ChatLibraryData;
  scope: ChatScope;
  busy: boolean;
  onScope: (scope: ChatScope) => void;
  onOpen: (id: string) => void;
  onNew: (taskId: string | null) => void;
  onTaskCreate: (name: string) => void;
  onTaskChange: (id: string, change: Partial<Pick<ChatTask, 'name' | 'done'>>) => void;
  onTaskRemove: (id: string) => void;
  onChatChange: (id: string, change: Partial<Pick<Conversation, 'name' | 'pinned' | 'taskId'>>) => void;
  onChatRemove: (id: string) => void;
  onClose?: () => void;
  onSettings?: () => void;
};

export function ChatLibrary({ library, scope, busy, onScope, onOpen, onNew, onTaskCreate,
  onTaskChange, onTaskRemove, onChatChange, onChatRemove, onClose, onSettings }: Props) {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const { chats, tasks, activeId } = library;
  const task = tasks.find((item) => item.id === scope);
  const activeMenuTask = menu?.kind === 'task' ? tasks.find((item) => item.id === menu.id) : undefined;
  const activeMenuChat = menu && menu.kind !== 'task' ? chats.find((item) => item.id === menu.id) : undefined;
  const search = query.trim().toLowerCase();
  const chatsToShow = chats.filter((chat) => {
    if (scope !== undefined && chat.taskId !== scope) return false;
    if (!hasConversationContent(chat)) return false;
    return !search || conversationName(chat).toLowerCase().includes(search)
      || chat.messages.some((message) => message.content.toLowerCase().includes(search));
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  const pinned = chatsToShow.filter((chat) => chat.pinned);
  const recent = chatsToShow.filter((chat) => !chat.pinned);
  const taskCounts = new Map<string, number>();
  for (const chat of chats) {
    if (chat.taskId && hasConversationContent(chat)) {
      taskCounts.set(chat.taskId, (taskCounts.get(chat.taskId) ?? 0) + 1);
    }
  }

  const closeTools = () => { setEditor(null); setMenu(null); };
  const startEdit = (value: Editor) => { setMenu(null); setEditor(value); };
  const selectScope = (next: ChatScope) => { closeTools(); onScope(next); };
  const saveName = () => {
    if (!editor || !editor.name.trim() || busy) return;
    const name = editor.name.trim();
    if (editor.kind === 'new') onTaskCreate(name);
    if (editor.kind === 'task' && editor.id) onTaskChange(editor.id, { name });
    if (editor.kind === 'chat' && editor.id) onChatChange(editor.id, { name });
    closeTools();
  };
  const renderChat = (chat: Conversation) => {
    const title = conversationName(chat);
    const label = tasks.find((item) => item.id === chat.taskId)?.name;
    return (
      <View key={chat.id} style={[styles.row, chat.id === activeId && styles.selected]}>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: chat.id === activeId }}
          style={styles.rowMain} disabled={busy} onPress={() => { closeTools(); onOpen(chat.id); }}>
          <Text style={styles.chatGlyph} accessible={false}>{chat.pinned ? '◆' : '▤'}</Text>
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
            {scope === undefined && label ? <Text style={styles.secondary} numberOfLines={1}>{label}</Text> : null}
          </View>
        </Pressable>
        <SmallButton label={`${title} 대화 옵션`} glyph="···" disabled={busy} onPress={() => {
          setEditor(null);
          setMenu({ kind: 'chat', id: chat.id });
        }} />
      </View>
    );
  };

  return (
    <View style={styles.panel}>
      <View style={styles.brand}>
        <View style={styles.brandMark} accessible={false}><Text style={styles.brandGlyph}>✦</Text></View>
        <View style={styles.rowCopy}>
          <Text style={styles.brandTitle} accessibilityRole="header" numberOfLines={1}>{APP_NAME}</Text>
          <Text style={styles.secondary}>대화와 테스크</Text>
        </View>
        {onClose ? <SmallButton label="메뉴 닫기" glyph="×" onPress={onClose} /> : null}
      </View>
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityRole="button" accessibilityLabel={task ? `${task.name}에서 새 대화` : '새 대화'}
          disabled={busy} style={[styles.primary, busy && styles.disabled]} onPress={() => onNew(task?.id ?? null)}>
          <Text style={styles.primaryText}>＋ 새 대화</Text>
        </Pressable>

        <View style={styles.search}>
          <Text style={styles.searchGlyph} accessible={false}>⌕</Text>
          <TextInput value={query} onChangeText={setQuery} placeholder="대화 검색" accessibilityLabel="대화 검색"
            placeholderTextColor={colors.muted} style={styles.searchInput} autoCorrect={false} returnKeyType="search" />
          {query ? <SmallButton label="검색 지우기" glyph="×" onPress={() => setQuery('')} /> : null}
        </View>

        <View style={styles.filters}>
          <Filter label="전체 대화" selected={scope === undefined} onPress={() => selectScope(undefined)} />
          <Filter label="미분류" selected={scope === null} onPress={() => selectScope(null)} />
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle} accessibilityRole="header">테스크</Text>
            <SmallButton label="테스크 만들기" glyph="＋" disabled={busy} onPress={() => startEdit({ kind: 'new', name: '' })} />
          </View>
          {tasks.length === 0 ? <Text style={styles.empty}>테스크를 만들면 관련 대화를 한곳에 모을 수 있어요.</Text> : null}
          {tasks.slice().sort((a, b) => Number(a.done) - Number(b.done)).map((item) => (
            <View key={item.id} style={[styles.row, item.id === scope && styles.selected]}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: item.id === scope }}
                accessibilityLabel={`${item.name}, ${item.done ? '완료' : '진행 중'}`}
                style={styles.rowMain} onPress={() => selectScope(item.id)}>
                <Text style={styles.taskGlyph} accessible={false}>{item.done ? '✓' : '◇'}</Text>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.secondary}>{item.done ? '완료' : '진행 중'} · {taskCounts.get(item.id) ?? 0}개 대화</Text>
                </View>
              </Pressable>
              <SmallButton label={`${item.name} 테스크 옵션`} glyph="···" disabled={busy} onPress={() => {
                setEditor(null);
                setMenu({ kind: 'task', id: item.id });
              }} />
            </View>
          ))}
        </View>

        {pinned.length ? <View style={styles.section}>
          <Text style={styles.sectionTitle} accessibilityRole="header">고정한 대화</Text>
          {pinned.map(renderChat)}
        </View> : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle} accessibilityRole="header" numberOfLines={1}>
            {task ? `${task.name}의 대화` : scope === null ? '미분류 대화' : '최근 대화'}
          </Text>
          {recent.map(renderChat)}
          {chatsToShow.length === 0 ? <Text style={styles.empty}>{search ? '검색 결과가 없어요.' : '저장된 대화가 없어요.'}</Text> : null}
        </View>
      </ScrollView>

      {editor ? (
        <View style={styles.tools}>
          <Text style={styles.toolsTitle}>{editor.kind === 'new' ? '새 테스크' : '이름 바꾸기'}</Text>
          <TextInput value={editor.name} onChangeText={(name) => setEditor({ ...editor, name })}
            accessibilityLabel="이름" placeholder="이름 입력" placeholderTextColor={colors.muted}
            style={styles.nameInput} maxLength={60} autoFocus returnKeyType="done" onSubmitEditing={saveName} />
          <View style={styles.toolButtons}>
            <ToolButton label="취소" onPress={closeTools} />
            <ToolButton label="저장" disabled={busy || !editor.name.trim()} onPress={saveName} />
          </View>
        </View>
      ) : menu && (activeMenuTask || activeMenuChat) ? (
        <View style={styles.tools}>
          <View style={styles.sectionHeader}>
            <Text style={styles.toolsTitle} numberOfLines={1}>{menu.kind === 'move' ? '테스크로 이동' : activeMenuTask?.name ?? (activeMenuChat && conversationName(activeMenuChat))}</Text>
            <SmallButton label="옵션 닫기" glyph="×" onPress={closeTools} />
          </View>
          {activeMenuTask ? <>
            <ToolButton label="이름 바꾸기" disabled={busy} onPress={() => startEdit({ kind: 'task', id: activeMenuTask.id, name: activeMenuTask.name })} />
            <ToolButton label={activeMenuTask.done ? '진행 중으로 변경' : '완료 표시'} disabled={busy} onPress={() => {
              onTaskChange(activeMenuTask.id, { done: !activeMenuTask.done }); closeTools();
            }} />
            <ToolButton label="테스크 삭제" danger disabled={busy} onPress={() => {
              Alert.alert('테스크 삭제', '이 테스크의 대화는 미분류로 이동합니다.', [
                { text: '취소', style: 'cancel' },
                { text: '삭제', style: 'destructive', onPress: () => { onTaskRemove(activeMenuTask.id); closeTools(); } },
              ]);
            }} />
          </> : activeMenuChat && menu.kind === 'move' ? (
            <ScrollView style={styles.destinations} keyboardShouldPersistTaps="handled">
              {[{ id: null, name: '미분류' }, ...tasks].map((target) => (
                <ToolButton key={target.id ?? 'unassigned'} label={target.name}
                  accessibilityLabel={`이동 위치 ${target.name}`}
                  disabled={busy || activeMenuChat.taskId === target.id} onPress={() => {
                    onChatChange(activeMenuChat.id, { taskId: target.id }); selectScope(target.id);
                  }} />
              ))}
            </ScrollView>
          ) : activeMenuChat ? <>
            <ToolButton label="이름 바꾸기" disabled={busy} onPress={() => startEdit({ kind: 'chat', id: activeMenuChat.id, name: conversationName(activeMenuChat) })} />
            <ToolButton label={activeMenuChat.pinned ? '고정 해제' : '대화 고정'} disabled={busy} onPress={() => {
              onChatChange(activeMenuChat.id, { pinned: !activeMenuChat.pinned }); closeTools();
            }} />
            <ToolButton label="테스크로 이동" disabled={busy} onPress={() => setMenu({ kind: 'move', id: activeMenuChat.id })} />
            <ToolButton label="대화 삭제" danger disabled={busy} onPress={() => {
              Alert.alert('대화 삭제', '이 대화와 첨부 파일을 이 기기에서 삭제합니다.', [
                { text: '취소', style: 'cancel' },
                { text: '삭제', style: 'destructive', onPress: () => { onChatRemove(activeMenuChat.id); closeTools(); } },
              ]);
            }} />
          </> : null}
        </View>
      ) : onSettings ? <View style={styles.footer}>
        <ToolButton label="설정" onPress={onSettings} disabled={busy} />
      </View> : null}
    </View>
  );
}

function SmallButton({ label, glyph, onPress, disabled }: { label: string; glyph: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [styles.iconButton, (pressed || disabled) && styles.disabled]}>
    <Text style={styles.iconText}>{glyph}</Text>
  </Pressable>;
}

function Filter({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
    style={[styles.filter, selected && styles.selected]}><Text style={styles.filterText}>{label}</Text></Pressable>;
}

function ToolButton({ label, accessibilityLabel, onPress, disabled, danger }: { label: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [styles.tool, (pressed || disabled) && styles.disabled]}>
    <Text style={[styles.toolText, danger && styles.danger]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, backgroundColor: colors.bg },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 15, paddingVertical: 10, borderBottomColor: colors.border, borderBottomWidth: 1 },
  brandMark: { width: 38, height: 38, borderRadius: 13, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  brandGlyph: { fontSize: 23, color: colors.accentText },
  brandTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  list: { padding: 12, gap: 13, paddingBottom: 22 },
  primary: { minHeight: 46, borderRadius: 13, backgroundColor: colors.accent, justifyContent: 'center', paddingHorizontal: 13 },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  search: { flexDirection: 'row', alignItems: 'center', paddingLeft: 12, minHeight: 46, borderRadius: 13, borderColor: colors.border, borderWidth: 1, backgroundColor: colors.card },
  searchGlyph: { fontSize: 21, color: colors.muted, marginRight: 7 },
  searchInput: { flex: 1, minWidth: 0, minHeight: 44, paddingRight: 8, color: colors.text, fontSize: 14 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  filter: { minHeight: 44, justifyContent: 'center', borderRadius: 12, paddingHorizontal: 11, backgroundColor: colors.card },
  filterText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  section: { gap: 4 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { color: colors.muted, fontSize: 13, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 5 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 46, borderRadius: 12 },
  selected: { backgroundColor: colors.accentSoft },
  rowMain: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 7, paddingVertical: 6 },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  secondary: { color: colors.muted, marginTop: 2, fontSize: 12 },
  taskGlyph: { color: colors.accentText, fontSize: 17, minWidth: 17, textAlign: 'center' },
  chatGlyph: { color: colors.accentText, fontSize: 14, minWidth: 17, textAlign: 'center' },
  iconButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 10 },
  iconText: { fontSize: 21, fontWeight: '800', color: colors.accentText },
  empty: { color: colors.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 6 },
  footer: { borderTopColor: colors.border, borderTopWidth: 1, paddingHorizontal: 12 },
  tools: { paddingHorizontal: 12, paddingBottom: 8, paddingTop: 5, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border },
  toolsTitle: { flexShrink: 1, color: colors.text, fontSize: 15, fontWeight: '800', paddingVertical: 7 },
  destinations: { maxHeight: 184 },
  nameInput: { color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 10, minHeight: 44, paddingHorizontal: 10, marginBottom: 4 },
  toolButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  tool: { minHeight: 44, paddingHorizontal: 9, justifyContent: 'center' },
  toolText: { color: colors.accentText, fontWeight: '700', fontSize: 14 },
  danger: { color: colors.danger },
  disabled: { opacity: 0.5 },
});

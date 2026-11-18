/**
 * 가벼운 Markdown 렌더러 (외부 의존성·네트워크 없음).
 *
 * 지원: # 제목, **굵게**, *기울임*, ~~취소선~~, `코드`, ``` 코드 블록 ```,
 *       * / - / + 목록(들여쓰기), 1. 번호 목록, > 인용, --- 구분선, [링크](url) → 글자만, 표는 글자 그대로.
 * 스트리밍 중 덜 닫힌 기호(예: "**굵")는 그냥 글자로 보인다.
 */
import { memo, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { colors, isDark } from './theme';

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: { marker: string; text: string; indent: number }[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'hr' };

const BULLET = /^(\s*)([*+-])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 코드 블록 (닫히지 않았으면 끝까지 = 스트리밍 중)
    if (/^\s*```/.test(line)) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].replace(/\s*#+\s*$/, '') });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      blocks.push({ type: 'hr' });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      blocks.push({ type: 'quote', text: q.join('\n') });
      continue;
    }
    const b = line.match(BULLET);
    const o = line.match(ORDERED);
    if (b || o) {
      flushPara();
      const ordered = !b;
      const items: { marker: string; text: string; indent: number }[] = [];
      while (i < lines.length) {
        const mb = lines[i].match(BULLET);
        const mo = lines[i].match(ORDERED);
        const m = mb ?? mo;
        if (m) {
          const indent = Math.min(3, Math.floor(m[1].replace(/\t/g, '    ').length / 2));
          items.push({ marker: mb ? '•' : `${m[2]}.`, text: m[3], indent });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // 목록 항목의 이어지는 줄
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i++;
        } else break;
      }
      i--;
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

// 인라인: **굵게** / __굵게__ / *기울임* / ~~취소~~ / `코드` / [텍스트](url)
// (_기울임_ 은 snake_case 같은 일반 글자와 헷갈려서 지원하지 않는다)
const INLINE =
  /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+`|~~[^~\n]+?~~|\*[^*\s][^*\n]*?\*|\[[^\]\n]+\]\([^)\n]+\))/;

function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest) {
    const m = rest.match(INLINE);
    if (!m || m.index === undefined) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${k++}`;
    if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(
        <Text key={key} style={styles.bold}>
          {renderInline(tok.slice(2, -2), key)}
        </Text>,
      );
    } else if (tok.startsWith('`')) {
      out.push(
        <Text key={key} style={styles.inlineCode}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (tok.startsWith('~~')) {
      out.push(
        <Text key={key} style={styles.strike}>
          {renderInline(tok.slice(2, -2), key)}
        </Text>,
      );
    } else if (tok.startsWith('[')) {
      // 오프라인 앱이므로 링크는 열지 않고 글자만 표시
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push(
        <Text key={key} style={styles.link}>
          {lm ? lm[1] : tok}
        </Text>,
      );
    } else {
      out.push(
        <Text key={key} style={styles.italic}>
          {renderInline(tok.slice(1, -1), key)}
        </Text>,
      );
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

const HEADING_SIZE = [22, 20, 18, 17, 16, 15];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.type) {
          case 'heading':
            return (
              <Text
                key={key}
                selectable
                style={[styles.text, styles.heading, { fontSize: HEADING_SIZE[b.level - 1] }]}
              >
                {renderInline(b.text, key)}
              </Text>
            );
          case 'paragraph':
            return (
              <Text key={key} selectable style={styles.text}>
                {renderInline(b.text, key)}
              </Text>
            );
          case 'list':
            return (
              <View key={key} style={styles.list}>
                {b.items.map((it, j) => (
                  <View key={j} style={[styles.listItem, { paddingLeft: it.indent * 16 }]}>
                    <Text style={[styles.text, b.ordered ? styles.olMarker : styles.ulMarker]}>
                      {it.indent > 0 && !b.ordered ? '◦' : it.marker}
                    </Text>
                    <Text selectable style={[styles.text, styles.listText]}>
                      {renderInline(it.text, `${key}-${j}`)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={key} style={styles.quote}>
                <Text selectable style={[styles.text, styles.quoteText]}>
                  {renderInline(b.text, key)}
                </Text>
              </View>
            );
          case 'code':
            return (
              <View key={key} style={styles.codeBlock}>
                <Text selectable style={styles.codeText}>
                  {b.text}
                </Text>
              </View>
            );
          case 'hr':
            return <View key={key} style={styles.hr} />;
        }
      })}
    </View>
  );
});

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });
const codeBg = isDark ? '#12151a' : '#f1f3f5';

const styles = StyleSheet.create({
  root: { gap: 8 },
  text: { fontSize: 15, lineHeight: 22, color: colors.text },
  heading: { fontWeight: '700', marginTop: 4 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { color: colors.accentText, textDecorationLine: 'underline' },
  inlineCode: { fontFamily: mono, fontSize: 13.5, backgroundColor: codeBg },
  list: { gap: 4 },
  listItem: { flexDirection: 'row' },
  ulMarker: { width: 16, color: colors.muted },
  olMarker: { minWidth: 22, color: colors.muted, fontVariant: ['tabular-nums'] },
  listText: { flex: 1 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 10 },
  quoteText: { color: colors.muted },
  codeBlock: { backgroundColor: codeBg, borderRadius: 8, padding: 10 },
  codeText: { fontFamily: mono, fontSize: 13, lineHeight: 19, color: colors.text },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 4 },
});

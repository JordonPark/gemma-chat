/**
 * 기기 안에서만 동작하는 도구 (네트워크 없음). MCP 처럼 "도구 목록 → 모델이 고르기 → 앱이 실행 → 결과로 답하기" 흐름이다.
 *  - 계산기: 작은 모델이 자주 틀리는 계산을 정확하게
 *  - 날짜·시간: 지금 시각, N일 뒤/전, 날짜 사이 일수, 요일
 *  - 단위 변환: 길이·무게·부피·넓이(평)·속도·데이터·시간·온도
 *  - 기억: "기억해 줘" 한 내용을 앱 저장소에 두고, 매 대화의 시스템 프롬프트에 넣어 기억하게 한다
 */
import { File, Paths } from 'expo-file-system';
import { quickScreen } from './contentSafety';

// ───────────────────────── 도구가 필요할 수 있는 말인지 (아니면 도구 고르기 단계를 건너뛰어 평소처럼 빠르게 답한다)

const GATE = [
  /\d\s*[-+*/×÷^xX]\s*\d|\d\s*%|계산|더하|빼면|빼기|곱하|나누|제곱|루트|√|퍼센트|할인|이자|평균|합계|몇\s*배/,
  /며칠|몇\s*일|요일|날짜|디데이|d-?day|D-\d|\d+\s*(일|주|주일|달|개월|년)\s*(뒤|후|전)|몇\s*시|지금\s*시간/i,
  /(cm|mm|km|kg|mg|lb|lbs|oz|inch|in\b|ft\b|mi\b|ml|mL|gal|mph|km\/h|knot|[KMGT]B\b|℃|℉)|인치|피트|마일|야드|파운드|온스|에이커|헥타르|섭씨|화씨|켈빈|리터|갤런|노트|미터|킬로|그램|센티|밀리|\d\s*(평|근|돈|냥|되|컵|도)\b|변환|환산|단위/,
  /기억|외워|잊어|잊어버려|메모해|알아\s*둬|알아두|저장해\s*(줘|둬)/,
];

export function mightNeedTool(text: string): boolean {
  return GATE.some((r) => r.test(text));
}

// ───────────────────────── 계산기 (eval 없이 직접 파싱)

export function calculate(expression: string): number {
  const src = expression
    .replace(/[,，\s]/g, '')
    .replace(/[×xX]/g, '*')
    .replace(/÷/g, '/')
    .replace(/√/g, 'sqrt')
    .replace(/π/g, 'pi')
    .toLowerCase();
  let i = 0;
  const eat = (c: string) => (src[i] === c ? (i++, true) : false);
  const FUNCS: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    log: Math.log10,
    ln: Math.log,
    sin: (x) => Math.sin((x * Math.PI) / 180),
    cos: (x) => Math.cos((x * Math.PI) / 180),
    tan: (x) => Math.tan((x * Math.PI) / 180),
  };
  const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

  const expr = (): number => {
    let v = term();
    for (;;) {
      if (eat('+')) v += term();
      else if (eat('-')) v -= term();
      else return v;
    }
  };
  const term = (): number => {
    let v = power();
    for (;;) {
      if (eat('*')) v *= power();
      else if (eat('/')) v /= power();
      else return v;
    }
  };
  const power = (): number => {
    const b = unary();
    if (eat('^')) return Math.pow(b, power()); // 오른쪽 결합
    if (src.startsWith('**', i)) {
      i += 2;
      return Math.pow(b, power());
    }
    return b;
  };
  const unary = (): number => {
    if (eat('-')) return -unary();
    if (eat('+')) return unary();
    return postfix();
  };
  const postfix = (): number => {
    let v = atom();
    while (eat('%')) v /= 100; // "20%" = 0.2
    return v;
  };
  const atom = (): number => {
    if (eat('(')) {
      const v = expr();
      if (!eat(')')) throw new Error('괄호가 맞지 않습니다');
      return v;
    }
    const num = /^\d*\.?\d+(e[-+]?\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return parseFloat(num[0]);
    }
    const name = /^[a-z]+/.exec(src.slice(i));
    if (name) {
      i += name[0].length;
      if (name[0] in CONSTS) return CONSTS[name[0]];
      const f = FUNCS[name[0]];
      if (!f) throw new Error(`모르는 함수: ${name[0]}`);
      return f(atom());
    }
    throw new Error(`계산식을 읽을 수 없습니다: ${src.slice(i, i + 10) || '(끝)'}`);
  };

  if (!src) throw new Error('빈 계산식');
  const v = expr();
  if (i < src.length) throw new Error(`계산식을 읽을 수 없습니다: ${src.slice(i, i + 10)}`);
  if (!Number.isFinite(v)) throw new Error('계산 결과가 숫자가 아닙니다 (0으로 나누기 등)');
  return v;
}

export function formatNumber(v: number): string {
  const r = Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toPrecision(8) : String(+v.toPrecision(12));
  if (r.includes('e')) return r;
  const [int, frac] = r.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
}

// ───────────────────────── 단위 변환

type Unit = { kind: string; factor: number; label: string };
/** 기준 단위: m, kg, L, m², m/s, byte, s (온도는 따로) */
const UNITS: Record<string, Unit> = {
  mm: { kind: '길이', factor: 0.001, label: 'mm' },
  cm: { kind: '길이', factor: 0.01, label: 'cm' },
  m: { kind: '길이', factor: 1, label: 'm' },
  km: { kind: '길이', factor: 1000, label: 'km' },
  in: { kind: '길이', factor: 0.0254, label: '인치' },
  ft: { kind: '길이', factor: 0.3048, label: '피트' },
  yd: { kind: '길이', factor: 0.9144, label: '야드' },
  mi: { kind: '길이', factor: 1609.344, label: '마일' },
  nmi: { kind: '길이', factor: 1852, label: '해리' },
  자: { kind: '길이', factor: 10 / 33, label: '자' },
  mg: { kind: '무게', factor: 1e-6, label: 'mg' },
  g: { kind: '무게', factor: 0.001, label: 'g' },
  kg: { kind: '무게', factor: 1, label: 'kg' },
  t: { kind: '무게', factor: 1000, label: '톤' },
  oz: { kind: '무게', factor: 0.028349523125, label: '온스' },
  lb: { kind: '무게', factor: 0.45359237, label: '파운드' },
  근: { kind: '무게', factor: 0.6, label: '근(600g)' },
  돈: { kind: '무게', factor: 0.00375, label: '돈' },
  냥: { kind: '무게', factor: 0.0375, label: '냥' },
  ml: { kind: '부피', factor: 0.001, label: 'mL' },
  l: { kind: '부피', factor: 1, label: 'L' },
  cup: { kind: '부피', factor: 0.2365882365, label: '컵(미국)' },
  floz: { kind: '부피', factor: 0.0295735295625, label: '액량 온스' },
  gal: { kind: '부피', factor: 3.785411784, label: '갤런(미국)' },
  되: { kind: '부피', factor: 1.8039, label: '되' },
  cm2: { kind: '넓이', factor: 1e-4, label: 'cm²' },
  m2: { kind: '넓이', factor: 1, label: 'm²' },
  km2: { kind: '넓이', factor: 1e6, label: 'km²' },
  ft2: { kind: '넓이', factor: 0.09290304, label: '제곱피트' },
  평: { kind: '넓이', factor: 400 / 121, label: '평' },
  acre: { kind: '넓이', factor: 4046.8564224, label: '에이커' },
  ha: { kind: '넓이', factor: 10000, label: '헥타르' },
  'm/s': { kind: '속도', factor: 1, label: 'm/s' },
  'km/h': { kind: '속도', factor: 1 / 3.6, label: 'km/h' },
  mph: { kind: '속도', factor: 0.44704, label: 'mph' },
  knot: { kind: '속도', factor: 1852 / 3600, label: '노트' },
  B: { kind: '데이터', factor: 1, label: 'B' },
  KB: { kind: '데이터', factor: 1024, label: 'KB' },
  MB: { kind: '데이터', factor: 1024 ** 2, label: 'MB' },
  GB: { kind: '데이터', factor: 1024 ** 3, label: 'GB' },
  TB: { kind: '데이터', factor: 1024 ** 4, label: 'TB' },
  s: { kind: '시간', factor: 1, label: '초' },
  min: { kind: '시간', factor: 60, label: '분' },
  h: { kind: '시간', factor: 3600, label: '시간' },
  day: { kind: '시간', factor: 86400, label: '일' },
  week: { kind: '시간', factor: 604800, label: '주' },
  C: { kind: '온도', factor: 0, label: '°C' },
  F: { kind: '온도', factor: 0, label: '°F' },
  K: { kind: '온도', factor: 0, label: 'K' },
};
export const UNIT_IDS = Object.keys(UNITS);

export function convertUnit(value: number, from: string, to: string): { value: number; text: string } {
  const a = UNITS[from];
  const b = UNITS[to];
  if (!a || !b) throw new Error('모르는 단위');
  if (a.kind !== b.kind) throw new Error(`${a.kind}와 ${b.kind}는 서로 바꿀 수 없습니다`);
  let out: number;
  if (a.kind === '온도') {
    const c = from === 'C' ? value : from === 'F' ? ((value - 32) * 5) / 9 : value - 273.15;
    out = to === 'C' ? c : to === 'F' ? (c * 9) / 5 + 32 : c + 273.15;
  } else {
    out = (value * a.factor) / b.factor;
  }
  return { value: out, text: `${formatNumber(value)} ${a.label} = ${formatNumber(+out.toPrecision(6))} ${b.label}` };
}

// ───────────────────────── 날짜·시간

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const korDate = (d: Date) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;

/** "2026-12-25" → 그 날 0시 (현지). 비었거나 잘못되면 오늘 */
function parseDate(s: string | undefined): Date {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((s ?? '').trim());
  const now = new Date();
  if (!m) return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

export function todayLine(now = new Date()): string {
  return `오늘은 ${korDate(now)}입니다.`;
}

export function dateTool(op: string, date: string, days: number, target: string): string {
  const now = new Date();
  switch (op) {
    case 'now': {
      const h = now.getHours();
      return `지금: ${korDate(now)} ${h < 12 ? '오전' : '오후'} ${h % 12 || 12}시 ${now.getMinutes()}분`;
    }
    case 'add': {
      const base = parseDate(date);
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Math.round(days));
      return `${korDate(base)}에서 ${Math.round(days)}일 ${days >= 0 ? '뒤' : '전'} = ${korDate(d)}`;
    }
    case 'diff': {
      const a = parseDate(date);
      const b = parseDate(target);
      const n = Math.round((b.getTime() - a.getTime()) / 86400000);
      return `${korDate(a)} → ${korDate(b)}: ${n >= 0 ? `${n}일 남음` : `${-n}일 지남`} (시작일을 1일로 세면 ${Math.abs(n) + 1}일째)`;
    }
    case 'weekday':
    default: {
      const d = parseDate(date || target);
      return `${ymd(d)}은 ${korDate(d)}`;
    }
  }
}

// ───────────────────────── 기억 (앱 저장소 Documents/.memory.json)

export type Memory = { id: string; text: string; at: number };
const memoryFile = () => new File(Paths.document, '.memory.json');
const MAX_MEMORIES = 50;

export function loadMemories(): Memory[] {
  try {
    const f = memoryFile();
    return f.exists ? (JSON.parse(f.textSync()) as Memory[]) : [];
  } catch {
    return [];
  }
}

function saveMemories(list: Memory[]) {
  const f = memoryFile();
  if (!f.exists) f.create();
  f.writeSync(JSON.stringify(list));
}

export function addMemory(text: string): Memory {
  const t = text.trim().slice(0, 200);
  if (!t) throw new Error('기억할 내용이 없습니다');
  const list = loadMemories().filter((m) => m.text !== t);
  const m = { id: Date.now().toString(36), text: t, at: Date.now() };
  saveMemories([...list, m].slice(-MAX_MEMORIES));
  return m;
}

export function removeMemory(id: string) {
  saveMemories(loadMemories().filter((m) => m.id !== id));
}

export function clearMemories() {
  saveMemories([]);
}

/** "잊어 줘": 낱말이 겹치는 기억을 지운다. 지운 개수 */
export function forgetMemories(query: string): Memory[] {
  const list = loadMemories();
  const words = query.split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  const gone = list.filter((m) => words.some((w) => m.text.includes(w)));
  saveMemories(list.filter((m) => !gone.includes(m)));
  return gone;
}

/** 시스템 프롬프트에 붙일 앱 정보 (날짜 + 기억). 날짜는 하루 단위라 대화 캐시가 자주 깨지지 않는다 */
export function contextForPrompt(): string {
  const mem = loadMemories();
  const lines = [todayLine()];
  if (mem.length) {
    lines.push('사용자가 기억해 달라고 한 내용 (관련 있을 때만 활용):');
    for (const m of mem) lines.push(`- ${m.text}`);
  }
  return lines.join('\n');
}

// ───────────────────────── 모델이 고른 도구 실행

export type ToolCall =
  | { tool: 'none' }
  | { tool: 'calculator'; expression: string }
  | { tool: 'date'; op: 'now' | 'add' | 'diff' | 'weekday'; date: string; days: number; target: string }
  | { tool: 'convert'; value: number; from: string; to: string }
  | { tool: 'remember'; text: string }
  | { tool: 'forget'; text: string };

/** 실행 결과: note = 모델에게 줄 결과, chip = 화면에 보여 줄 짧은 표시 */
export type ToolResult = { note: string; chip: string };

export function runTool(call: ToolCall): ToolResult | null {
  switch (call.tool) {
    case 'calculator': {
      const v = calculate(call.expression);
      const r = `${call.expression} = ${formatNumber(v)}`;
      return { note: `계산기: ${r}`, chip: `🧮 ${r}` };
    }
    case 'date': {
      const r = dateTool(call.op, call.date, call.days, call.target);
      return { note: `날짜 계산: ${r}`, chip: `📅 ${r}` };
    }
    case 'convert': {
      const r = convertUnit(call.value, call.from, call.to).text;
      return { note: `단위 변환: ${r}`, chip: `📏 ${r}` };
    }
    case 'remember': {
      // 기억은 매 대화의 시스템 프롬프트에 들어가므로, 우회 지시나 유해한 내용은 저장하지 않는다
      if (quickScreen(call.text)) {
        return { note: '이 내용은 이용 기준에 맞지 않아 기억하지 않았습니다. 그렇게 안내하세요.', chip: '🧠 기억하지 않음 (이용 기준)' };
      }
      const m = addMemory(call.text);
      return { note: `기억 저장 완료: "${m.text}" (앞으로 대화에서 기억합니다)`, chip: `🧠 기억함: ${m.text}` };
    }
    case 'forget': {
      const gone = forgetMemories(call.text);
      return gone.length
        ? { note: `기억 삭제 완료: ${gone.map((m) => `"${m.text}"`).join(', ')}`, chip: `🧠 잊음: ${gone.map((m) => m.text).join(', ')}` }
        : { note: '지울 만한 기억을 찾지 못했습니다. 설정 › 기억에서 직접 지울 수 있다고 안내하세요.', chip: '🧠 해당 기억 없음' };
    }
    default:
      return null;
  }
}

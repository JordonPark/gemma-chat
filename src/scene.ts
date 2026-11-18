/**
 * 일러스트 = "부품 목록(JSON)" → 앱이 직접 SVG 로 그리기.
 *
 * 4B 모델은 SVG path 좌표를 직접 쓰면 몇 개 그리다 멈추거나 형태가 무너진다.
 * 그래서 모델에게는 부품(역할·도형·위치·크기·색)만 JSON 스키마로 강제해서 받고,
 * 외곽선·눈 하이라이트·볼터치·겹치는 순서 같은 "그림체"는 여기서 일정하게 입힌다.
 */

export const ROLES = [
  'sky_item', // 해, 구름, 별
  'ground',
  'scenery', // 나무, 꽃, 집 등 배경 사물
  'tail',
  'wing',
  'ear',
  'inner_ear',
  'leg',
  'arm',
  'body',
  'belly',
  'paw',
  'head',
  'hair',
  'cheek',
  'eye',
  'pupil',
  'eye_highlight',
  'nose',
  'mouth',
  'whisker',
  'beak',
  'fin',
  'pattern', // 줄무늬, 점무늬
  'hat',
  'accessory',
  'object', // 주인공이 사물일 때의 부품
  'detail',
] as const;
export type Role = (typeof ROLES)[number];

export const SHAPES = ['circle', 'ellipse', 'rect', 'roundrect', 'triangle', 'line', 'smile'] as const;
export type Shape = (typeof SHAPES)[number];

export type Part = {
  role: Role;
  shape: Shape;
  /** 중심 좌표 (0~512) */
  x: number;
  y: number;
  /** 폭·높이 (circle 은 w 만 지름으로 씀) */
  w: number;
  h: number;
  /** 회전 각도 (도) */
  rotate: number;
  color: string;
};

export type Scene = { background: string; parts: Part[] };

const COORD = { type: 'integer', minimum: 0, maximum: 512 };
export const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    background: { type: 'string' },
    parts: {
      type: 'array',
      minItems: 12,
      maxItems: 45,
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ROLES },
          shape: { type: 'string', enum: SHAPES },
          x: COORD,
          y: COORD,
          w: COORD,
          h: COORD,
          rotate: { type: 'integer', minimum: -180, maximum: 180 },
          color: { type: 'string' },
        },
        required: ['role', 'shape', 'x', 'y', 'w', 'h', 'rotate', 'color'],
      },
    },
  },
  required: ['background', 'parts'],
};

/** 예시: 눈사람 (흔한 요청과 겹치지 않는 주제) */
const EXAMPLE = {
  background: '#dff1fb',
  parts: [
    { role: 'sky_item', shape: 'circle', x: 430, y: 80, w: 70, h: 70, rotate: 0, color: '#ffd54f' },
    { role: 'ground', shape: 'rect', x: 256, y: 460, w: 512, h: 104, rotate: 0, color: '#ffffff' },
    { role: 'body', shape: 'circle', x: 256, y: 360, w: 190, h: 190, rotate: 0, color: '#ffffff' },
    { role: 'arm', shape: 'line', x: 150, y: 320, w: 110, h: 8, rotate: -25, color: '#8d6e63' },
    { role: 'arm', shape: 'line', x: 362, y: 320, w: 110, h: 8, rotate: 25, color: '#8d6e63' },
    { role: 'head', shape: 'circle', x: 256, y: 200, w: 140, h: 140, rotate: 0, color: '#ffffff' },
    { role: 'hat', shape: 'rect', x: 256, y: 120, w: 90, h: 70, rotate: 0, color: '#37474f' },
    { role: 'hat', shape: 'rect', x: 256, y: 152, w: 140, h: 14, rotate: 0, color: '#37474f' },
    { role: 'eye', shape: 'circle', x: 230, y: 190, w: 18, h: 18, rotate: 0, color: '#263238' },
    { role: 'eye', shape: 'circle', x: 282, y: 190, w: 18, h: 18, rotate: 0, color: '#263238' },
    { role: 'nose', shape: 'triangle', x: 270, y: 212, w: 20, h: 44, rotate: 90, color: '#ff8a50' },
    { role: 'mouth', shape: 'smile', x: 256, y: 235, w: 50, h: 18, rotate: 0, color: '#3b2f2f' },
    { role: 'cheek', shape: 'ellipse', x: 214, y: 220, w: 22, h: 14, rotate: 0, color: '#ff8a80' },
    { role: 'cheek', shape: 'ellipse', x: 298, y: 220, w: 22, h: 14, rotate: 0, color: '#ff8a80' },
    { role: 'accessory', shape: 'roundrect', x: 256, y: 268, w: 150, h: 26, rotate: 0, color: '#e53935' },
    { role: 'detail', shape: 'circle', x: 256, y: 330, w: 16, h: 16, rotate: 0, color: '#37474f' },
    { role: 'detail', shape: 'circle', x: 256, y: 375, w: 16, h: 16, rotate: 0, color: '#37474f' },
  ],
};

export function scenePrompt(description: string): string {
  return [
    'You design cute flat vector illustrations by listing simple parts.',
    `Subject to draw (may be in Korean): ${description.trim()}`,
    '',
    'Canvas is 512x512, origin top-left. Each part: role, shape, center x,y, width w, height h, rotate (degrees), color (hex).',
    'Shapes: circle, ellipse, rect, roundrect, triangle (points up before rotation), line (horizontal stroke of length w before rotation), smile (a curved mouth line).',
    'The app adds outlines, eye highlights and layering automatically. You only choose the parts.',
    '',
    'Example for "a snowman":',
    JSON.stringify(EXAMPLE),
    '',
    'Rules:',
    '- Put the main subject in the center, about 300 to 380 pixels tall. Use a pale background and colors that contrast with it.',
    '- Include EVERY recognizable part. Animals and characters: head, two ears (with inner_ear), two eyes, two pupils (dark, inside the eyes), nose, mouth (smile), two cheeks, body, belly, legs or paws, tail. Cat: triangle ears on top of the head and 3 whiskers on each side (lines). Dog: ellipse ears hanging down. Rabbit: long ellipse ears. Bird: beak (triangle) and wings.',
    '- Parts must touch and overlap correctly: ears sit on the top edge of the head, eyes are inside the head at about 45% of its height, the head overlaps the top of the body.',
    '- Add 1 to 3 scenery or sky items if they fit (sun, cloud, flower, grass).',
    '- 14 to 40 parts. Answer with JSON only.',
  ].join('\n');
}

// ───────────── 렌더링 ─────────────

const OUTLINE = '#3b2f2f';
const NO_OUTLINE: Role[] = ['eye_highlight', 'cheek', 'pattern', 'ground', 'sky_item'];
const STROKE_ONLY: Shape[] = ['line', 'smile'];

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.max(lo, Math.min(hi, n));
};
const color = (c: unknown, d: string) =>
  typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()) ? c.trim() : d;

function normalize(p: Partial<Part>): Part | null {
  if (!p || !ROLES.includes(p.role as Role) || !SHAPES.includes(p.shape as Shape)) return null;
  return {
    role: p.role as Role,
    shape: p.shape as Shape,
    x: clamp(p.x, -50, 562, 256),
    y: clamp(p.y, -50, 562, 256),
    w: clamp(p.w, 2, 600, 40),
    h: clamp(p.h, 2, 600, 40),
    rotate: clamp(p.rotate, -360, 360, 0),
    color: color(p.color, p.role === 'pupil' ? '#2b2b2b' : '#cccccc'),
  };
}

function shapeSvg(p: Part): string {
  const { x, y, w, h } = p;
  const tf = p.rotate ? ` transform="rotate(${p.rotate} ${x} ${y})"` : '';
  const outline = !NO_OUTLINE.includes(p.role);
  const stroke = outline ? ` stroke="${OUTLINE}" stroke-width="5" stroke-linejoin="round"` : '';
  const fill = ` fill="${p.color}"`;
  const extra = p.role === 'cheek' ? ' opacity="0.55"' : p.role === 'eye_highlight' ? ' opacity="0.95"' : '';
  switch (p.shape) {
    case 'circle':
      return `<circle cx="${x}" cy="${y}" r="${Math.max(w, h) / 2}"${fill}${stroke}${extra}${tf}/>`;
    case 'ellipse':
      return `<ellipse cx="${x}" cy="${y}" rx="${w / 2}" ry="${h / 2}"${fill}${stroke}${extra}${tf}/>`;
    case 'rect':
      return `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}"${fill}${stroke}${extra}${tf}/>`;
    case 'roundrect': {
      const r = Math.min(w, h) * 0.3;
      return `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${r}"${fill}${stroke}${extra}${tf}/>`;
    }
    case 'triangle': {
      const pts = `${x},${y - h / 2} ${x + w / 2},${y + h / 2} ${x - w / 2},${y + h / 2}`;
      return `<polygon points="${pts}"${fill}${stroke}${extra}${tf}/>`;
    }
    case 'line': {
      const sw = Math.max(3, Math.min(h, 14));
      return `<line x1="${x - w / 2}" y1="${y}" x2="${x + w / 2}" y2="${y}" stroke="${p.role === 'whisker' ? OUTLINE : p.color}" stroke-width="${sw}" stroke-linecap="round"${tf}/>`;
    }
    case 'smile': {
      const d = `M${x - w / 2} ${y - h / 2} Q${x} ${y + h} ${x + w / 2} ${y - h / 2}`;
      return `<path d="${d}" fill="none" stroke="${color(p.color, OUTLINE)}" stroke-width="5" stroke-linecap="round"${tf}/>`;
    }
  }
}

/** 부품 목록을 SVG 로. 역할 순서대로 겹치고, 눈동자에는 하이라이트를 자동으로 넣는다 */
export function renderScene(scene: { background?: unknown; parts?: unknown[] }): string {
  const parts = (scene.parts ?? []).map((p) => normalize(p as Partial<Part>)).filter((p): p is Part => !!p);
  const order = (r: Role) => ROLES.indexOf(r);
  const sorted = parts
    .map((p, i) => ({ p, i }))
    .sort((a, b) => order(a.p.role) - order(b.p.role) || a.i - b.i)
    .map(({ p }) => p);

  const body: string[] = [];
  for (const p of sorted) {
    if (p.role === 'pupil' && STROKE_ONLY.includes(p.shape)) continue;
    body.push(shapeSvg(p));
  }
  // 하이라이트가 없으면 눈동자마다 작은 흰 점을 찍어 생기를 준다
  if (!parts.some((p) => p.role === 'eye_highlight')) {
    for (const p of parts.filter((q) => q.role === 'pupil' || (q.role === 'eye' && !parts.some((r) => r.role === 'pupil')))) {
      const r = Math.max(2, Math.min(p.w, p.h) * 0.18);
      body.push(`<circle cx="${p.x - p.w * 0.18}" cy="${p.y - p.h * 0.2}" r="${r}" fill="#ffffff"/>`);
    }
  }
  const bg = color(scene.background, '#eef6fb');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">` +
    `<rect width="512" height="512" fill="${bg}"/>${body.join('')}</svg>`
  );
}

/** 스트리밍 중인 JSON 에서 지금까지 완성된 부품만 꺼내 그린다 */
export function renderPartialScene(raw: string): string | null {
  const bgm = raw.match(/"background"\s*:\s*"([^"]*)"/);
  const start = raw.indexOf('[');
  if (start < 0) return null;
  const parts: unknown[] = [];
  const re = /\{[^{}]*\}/g;
  re.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    try {
      parts.push(JSON.parse(m[0]));
    } catch {
      // 덜 쓴 객체는 건너뜀
    }
  }
  if (!parts.length) return null;
  return renderScene({ background: bgm?.[1], parts });
}

export function parseScene(raw: string): Scene | null {
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (!Array.isArray(j?.parts)) return null;
    return j as Scene;
  } catch {
    return null;
  }
}

export const EXAMPLE_SCENE = EXAMPLE;

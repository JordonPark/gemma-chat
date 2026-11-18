/**
 * Gemma 가 쓴 SVG 다루기: 답에서 SVG 만 꺼내기, 위험한 요소 제거, 스트리밍 중 미완성 SVG 를 그릴 수 있게 닫아 주기.
 * (외부 의존성 없음. react-native-svg 는 스크립트를 실행하지 않지만, 외부 링크·이미지 등은 미리 지운다)
 */

/** 모델 답에서 <svg …> 부터 꺼낸다 (```svg 코드 블록이나 앞뒤 설명이 섞여도 됨). 없으면 null */
export function extractSvg(raw: string): string | null {
  const start = raw.search(/<svg[\s>]/i);
  if (start < 0) return null;
  const end = raw.toLowerCase().lastIndexOf('</svg>');
  return end > start ? raw.slice(start, end + '</svg>'.length) : raw.slice(start);
}

/** 외부 참조·스크립트·이벤트 속성 제거, 크기 고정 */
export function sanitizeSvg(svg: string): string {
  let s = svg
    .replace(/<\?xml[^>]*>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|foreignObject|image|iframe|style)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|image|iframe|style)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/\s(xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '');

  // 루트 <svg> : viewBox 보장, width/height 는 화면에 맞게 100%
  s = s.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '');
    if (!/viewBox\s*=/.test(a)) a += ' viewBox="0 0 512 512"';
    if (!/xmlns\s*=/.test(a)) a += ' xmlns="http://www.w3.org/2000/svg"';
    return `<svg${a} width="100%" height="100%">`;
  });
  return s;
}

/**
 * 스트리밍 중인 미완성 SVG 를 그릴 수 있는 상태로 만든다.
 * 마지막으로 완전히 닫힌 태그까지만 남기고, 열려 있는 그룹 태그와 </svg> 를 닫아 준다.
 */
export function closePartialSvg(partial: string): string | null {
  const s = extractSvg(partial);
  if (!s) return null;
  if (/<\/svg>\s*$/i.test(s)) return s;
  // 루트 <svg …> 가 아직 다 안 왔으면 그릴 수 없다
  const rootEnd = s.indexOf('>');
  if (rootEnd < 0) return null;
  // 마지막으로 완성된 태그 끝(>)까지 자르기
  const lastGt = s.lastIndexOf('>');
  let body = s.slice(0, lastGt + 1);
  // 따옴표 안에서 끊긴 경우 대비: 마지막 '<' 가 '>' 보다 뒤면 그 앞까지
  const lastLt = body.lastIndexOf('<');
  if (lastLt > body.lastIndexOf('>')) body = body.slice(0, lastLt);

  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const [, close, name, selfClose] = m;
    if (selfClose) continue;
    if (close) {
      const i = stack.lastIndexOf(name);
      if (i >= 0) stack.splice(i);
    } else {
      stack.push(name);
    }
  }
  // svg 루트를 빼고, 열려 있는 태그를 안쪽부터 닫는다
  const closers = stack
    .slice(1)
    .reverse()
    .map((t) => `</${t}>`)
    .join('');
  return `${body}${closers}</svg>`;
}

/** 그림 요소 개수 (진행 표시용) */
export function countShapes(svg: string): number {
  return (svg.match(/<(rect|circle|ellipse|polygon|polyline|path|line)\b/gi) ?? []).length;
}

/** 그림 요청 프롬프트 */
export function illustrationPrompt(description: string): string {
  return [
    'You are an illustrator who draws with SVG code.',
    `Draw this as a flat vector illustration: ${description.trim()}`,
    '',
    'Output ONLY one SVG document. No explanation, no markdown fences.',
    'Rules:',
    '- Start with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">.',
    '- First element: a full-size background <rect> in a soft color.',
    '- Flat illustration style: soft harmonious colors, simple clean shapes, a clear main subject in the center.',
    '- Use rect, circle, ellipse, polygon and path (simple curves). Group parts of the same object with <g>.',
    '- 15 to 45 elements in total. Keep it compact.',
    '- No text, no <image>, no scripts, no external links, no filters.',
  ].join('\n');
}

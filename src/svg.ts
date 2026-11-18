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

/**
 * 완성 예시 (작은 모델은 예시를 보면 구조·스타일을 훨씬 잘 따라 한다).
 * 주제와 상관없는 사과를 써서 결과가 예시를 베끼지 않게 한다.
 */
const EXAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<!-- plan: light-blue background; wooden table at bottom (y 380+); red apple body centered (256,290), about 230 wide; dark outline on main shapes; brown stem and green leaf on top; white highlight on upper left; soft shadow under apple -->
<rect width="512" height="512" fill="#dff1fb"/>
<rect y="380" width="512" height="132" fill="#d9b48a" stroke="#3b2f2f" stroke-width="5"/>
<ellipse cx="256" cy="398" rx="125" ry="18" fill="#b98f62"/>
<g stroke="#3b2f2f" stroke-width="6" stroke-linejoin="round" stroke-linecap="round">
<path d="M256 190 C190 150 128 200 140 282 C152 362 212 410 256 394 C300 410 360 362 372 282 C384 200 322 150 256 190 Z" fill="#e8504a"/>
<path d="M256 192 C258 160 262 140 274 122" fill="none"/>
<path d="M270 152 C300 118 342 122 354 140 C332 166 296 172 270 152 Z" fill="#6cbf5a"/>
</g>
<ellipse cx="198" cy="248" rx="20" ry="40" fill="#ffffff" opacity="0.6" transform="rotate(-22 198 248)"/>
</svg>`;

/** 그림 요청 프롬프트 */
export function illustrationPrompt(description: string): string {
  return [
    'You are a skilled illustrator who draws cute, clean flat vector illustrations as SVG code.',
    `Subject to draw (may be in Korean): ${description.trim()}`,
    '',
    'Here is an example of the expected style and structure (a different subject):',
    EXAMPLE_SVG,
    '',
    'Now draw the requested subject in the same style. Rules:',
    '1. Output ONLY one SVG document: no explanation, no markdown fences.',
    '2. Start with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">, then a <!-- plan: ... --> comment that lists EVERY part of the subject with its shape, color and approximate x,y position and size. Then draw following that plan exactly.',
    '3. Background: a full-size <rect> in a soft pale color, plus a simple ground or decoration (hill, floor, clouds, stars) if it fits.',
    '4. The main subject is centered and fills about 60% of the canvas. Its colors must contrast clearly with the background.',
    '5. Draw from back to front. Parts must overlap and connect naturally (e.g. the head sits on the body, ears attach to the top of the head).',
    '6. Put the main shapes in a <g stroke="#3b2f2f" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"> so they get a dark outline.',
    '7. Animals and characters: big round head, two ears, two eyes (white circle + dark pupil + tiny white highlight), nose, a smiling mouth (curved path), cheeks, body, legs or paws, tail. Recognizable features matter most (cat: pointed triangle ears + whiskers; dog: floppy ears; rabbit: long ears; bird: beak + wings).',
    '8. Objects and scenes: show the 3 to 6 most recognizable parts, add one highlight and one shadow.',
    '9. Use a palette of 4 to 7 colors. 20 to 50 elements. No text, no <image>, no scripts, no filters.',
  ].join('\n');
}

/**
 * 새 답을 한 번에 "툭" 띄우지 않고, 타자 치듯 부드럽게 풀어 보여 준다.
 * (안전 검사를 통과한 뒤에 답을 보여 주므로 진짜 스트리밍 대신 화면에서만 천천히 펼친다)
 * - 긴 답도 약 1.5초 안에 다 나오도록 속도를 맞춘다
 * - 처음 나타날 때만 펼치고, 다시 그려질 때는 바로 전체를 보여 준다
 */
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { Markdown } from './Markdown';

let reduceMotion = false;
AccessibilityInfo.isReduceMotionEnabled?.()
  .then((v) => {
    reduceMotion = v;
  })
  .catch(() => {});

export function TypewriterMarkdown({
  text,
  animate,
  onTyping,
}: {
  text: string;
  animate: boolean;
  /** 펼치는 동안 true, 끝나면 false (스크롤을 애니메이션 없이 따라가게) */
  onTyping?: (typing: boolean) => void;
}) {
  const chars = useRef(Array.from(text)).current;
  const [initial] = useState(() => animate && !reduceMotion && chars.length > 12);
  const [shown, setShown] = useState(initial ? 0 : chars.length);

  useEffect(() => {
    if (!initial) return;
    onTyping?.(true);
    // 초당 최소 90자, 길면 1.5초 안에 끝나게
    const perMs = Math.max(0.09, chars.length / 1500);
    const start = Date.now();
    let frame: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      onTyping?.(false);
    };
    // 약 30fps 로 다시 그린다 (긴 마크다운을 매 프레임 다시 그리지 않게)
    const tick = () => {
      const n = Math.min(chars.length, Math.ceil((Date.now() - start) * perMs));
      if (n !== last) {
        last = n;
        setShown(n);
      }
      if (n < chars.length) frame = setTimeout(tick, 33);
      else end();
    };
    tick();
    return () => {
      if (frame) clearTimeout(frame);
      end();
    };
    // 처음 한 번만 펼친다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Markdown text={shown >= chars.length ? text : chars.slice(0, shown).join('')} />;
}

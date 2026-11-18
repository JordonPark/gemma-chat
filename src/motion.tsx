/**
 * 앱 전체에서 쓰는 부드러운 움직임.
 *  - smoothLayout(): 다음 화면 변화(나타남·사라짐·밀려남)를 부드럽게
 *  - FadeIn: 처음 나타날 때 살짝 올라오며 서서히 보이기 (새 말풍선 등)
 *  - PressableScale: 누르면 살짝 작아졌다 돌아오는 버튼
 *  - TypingDots: "생각 중" 점 세 개가 물결처럼 움직임
 *  - Segmented: 셋 중 하나 고르기, 선택 표시가 미끄러지듯 옮겨 감
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors } from './theme';

/** "동작 줄이기"를 켠 사용자에게는 움직임을 끈다 */
let reduceMotion = false;
AccessibilityInfo.isReduceMotionEnabled?.()
  .then((v) => {
    reduceMotion = v;
  })
  .catch(() => {});
AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => {
  reduceMotion = v;
});

/** 다음 상태 변경으로 생기는 레이아웃 변화를 부드럽게 (state 를 바꾸기 바로 전에 부른다) */
export function smoothLayout(duration = 220) {
  if (reduceMotion) return;
  LayoutAnimation.configureNext(LayoutAnimation.create(duration, 'easeInEaseOut', 'opacity'));
}

/** 처음 나타날 때 살짝 올라오며 서서히 보인다. animate=false 면 바로 보인다 (예: 저장된 대화 불러오기) */
export function FadeIn({
  animate = true,
  delay = 0,
  offset = 10,
  style,
  children,
}: {
  animate?: boolean;
  delay?: number;
  offset?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  // 처음 나타날 때의 animate 값만 쓴다 (다시 그려질 때 값이 바뀌어도 투명한 채로 남지 않게)
  const [initial] = useState(() => animate && !reduceMotion);
  const [v] = useState(() => new Animated.Value(initial ? 0 : 1));
  useEffect(() => {
    if (!initial) return;
    Animated.timing(v, { toValue: 1, duration: 260, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [initial, delay, v]);
  return (
    <Animated.View
      style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }) }] }]}
    >
      {children}
    </Animated.View>
  );
}

/** 누르면 살짝 작아졌다가 튕기듯 돌아오는 버튼 (Pressable 과 같은 사용법, style 은 배열·객체) */
export function PressableScale({
  style,
  children,
  onPressIn,
  onPressOut,
  scaleTo = 0.96,
  ...rest
}: Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle>; scaleTo?: number; children?: ReactNode }) {
  const [scale] = useState(() => new Animated.Value(1));
  const to = (value: number) =>
    reduceMotion
      ? undefined
      : Animated.spring(scale, { toValue: value, useNativeDriver: true, speed: 40, bounciness: value === 1 ? 6 : 0 }).start();
  return (
    <Pressable
      {...rest}
      onPressIn={(e) => {
        to(scaleTo);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        to(1);
        onPressOut?.(e);
      }}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

/** "생각 중" 점 세 개가 물결처럼 오르내린다 */
export function TypingDots({ color = colors.muted }: { color?: string }) {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (reduceMotion) return;
    const loops = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 140),
          Animated.timing(d, { toValue: 1, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(d, { toValue: 0, duration: 300, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.delay((2 - i) * 140 + 200),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);
  return (
    <View style={styles.dots} accessibilityLabel="답변을 준비하는 중">
      {dots.map((d, i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            { backgroundColor: color },
            {
              opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
              transform: [{ translateY: d.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }],
            },
          ]}
        />
      ))}
    </View>
  );
}

/** 셋(여러 개) 중 하나 고르기. 선택 표시(보라색)가 미끄러지듯 옮겨 간다 */
export function Segmented({
  options,
  selected,
  onSelect,
}: {
  options: readonly string[];
  /** 선택된 칸 번호. -1 이면 아무것도 선택 안 됨 */
  selected: number;
  onSelect: (index: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const [x] = useState(() => new Animated.Value(Math.max(0, selected)));
  const [shown] = useState(() => new Animated.Value(selected >= 0 ? 1 : 0));
  useEffect(() => {
    if (selected >= 0) {
      if (reduceMotion) x.setValue(selected);
      else Animated.spring(x, { toValue: selected, useNativeDriver: true, speed: 18, bounciness: 4 }).start();
    }
    Animated.timing(shown, { toValue: selected >= 0 ? 1 : 0, duration: 180, useNativeDriver: true }).start();
  }, [selected, x, shown]);
  const PAD = 4;
  const itemW = width > 0 ? (width - PAD * 2 - (options.length - 1) * 4) / options.length : 0;
  return (
    <View style={styles.segment} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {itemW > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.segmentThumb,
            {
              width: itemW,
              opacity: shown,
              transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, itemW + 4] }) }],
            },
          ]}
        />
      ) : null}
      {options.map((label, i) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityState={{ selected: i === selected }}
          onPress={() => onSelect(i)}
          style={styles.segmentItem}
        >
          <Text style={[styles.segmentText, i === selected && styles.segmentTextOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: 'row', gap: 5, paddingVertical: 6, alignItems: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    gap: 4,
    marginTop: 6,
  },
  segmentThumb: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 4,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  segmentItem: { flex: 1, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 15, fontWeight: '600', color: colors.text },
  segmentTextOn: { color: '#fff' },
});

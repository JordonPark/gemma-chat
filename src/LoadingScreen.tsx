/**
 * 첫 로딩 화면 (앱 시작 → 설치된 모델 찾기 → 모델 불러오기).
 * 순수 JS 화면이라 OTA 업데이트로 바꿀 수 있다.
 * (앱 아이콘을 누른 직후의 시스템 스플래시는 네이티브라 OTA 로 바뀌지 않는다)
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, Text, View } from 'react-native';
import { APP_NAME } from './storeConfig';
import { colors, isDark } from './theme';

type Props = {
  /** 0~100. 없으면 진행률을 모르는 상태(움직이는 막대) */
  pct?: number;
  status: string;
  detail?: string;
};

const TIPS = [
  '모든 대화는 이 기기 안에서만 처리됩니다',
  '모델을 한 번 받으면 인터넷 없이 대화할 수 있어요',
  '설정에서 GPU 가속과 답변 길이를 바꿀 수 있어요',
];

export function LoadingScreen({ pct, status, detail }: Props) {
  const pulse = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const fillAnim = useRef(new Animated.Value(0)).current;
  const tip = TIPS[Math.floor(Date.now() / 4000) % TIPS.length];

  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 450, useNativeDriver: true }).start();
    const p = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    const s = Animated.loop(
      Animated.timing(sweep, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
    );
    p.start();
    s.start();
    return () => {
      p.stop();
      s.stop();
    };
  }, [fade, pulse, sweep]);

  // 진행률이 툭툭 끊기지 않고 부드럽게 차오르도록
  useEffect(() => {
    if (typeof pct !== 'number') return;
    Animated.timing(fillAnim, {
      toValue: Math.min(100, Math.max(2, pct)),
      duration: 350,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [pct, fillAnim]);
  const fillWidth = fillAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.55] });
  const sweepX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-120, 240] });
  const known = typeof pct === 'number' && pct > 0;

  return (
    <Animated.View style={[styles.root, { opacity: fade }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.center}>
          <View style={styles.logoWrap}>
            <Animated.View style={[styles.glow, { opacity: glow, transform: [{ scale }] }]} />
            <Animated.View style={[styles.logo, { transform: [{ scale }] }]}>
              <Text style={styles.logoMark}>✦</Text>
            </Animated.View>
          </View>

          <Text style={styles.title}>{APP_NAME}</Text>
          <Text style={styles.subtitle}>온디바이스 AI · 인터넷 없이 대화</Text>

          <View style={styles.progressBlock}>
            <View style={styles.track}>
              {known ? (
                <Animated.View style={[styles.fill, { width: fillWidth }]} />
              ) : (
                <Animated.View style={[styles.sweep, { transform: [{ translateX: sweepX }] }]} />
              )}
            </View>
            <View style={styles.statusRow}>
              <Text style={styles.status}>{status}</Text>
              {known ? <Text style={styles.pct}>{Math.round(pct!)}%</Text> : null}
            </View>
            {detail ? (
              <Text style={styles.detail} numberOfLines={1}>
                {detail}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={styles.tip}>{tip}</Text>
          <Text style={styles.model}>Gemma 3 4B · QAT Q4_0</Text>
        </View>
      </ScrollView>
    </Animated.View>
  );
}

const LOGO = 96;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 32 },
  content: { flexGrow: 1, gap: 20, paddingVertical: 14 },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  logoWrap: { width: LOGO * 1.8, height: LOGO * 1.8, alignItems: 'center', justifyContent: 'center' },
  glow: {
    position: 'absolute',
    width: LOGO * 1.6,
    height: LOGO * 1.6,
    borderRadius: LOGO,
    backgroundColor: colors.accent,
  },
  logo: {
    width: LOGO,
    height: LOGO,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: isDark ? 0.5 : 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  logoMark: { color: '#fff', fontSize: 46, lineHeight: 54, fontWeight: '700' },
  title: { marginTop: 8, fontSize: 30, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  subtitle: { marginTop: 6, fontSize: 15, color: colors.muted },
  progressBlock: { marginTop: 22, width: '100%', maxWidth: 320, gap: 10 },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  sweep: { width: 120, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  status: { fontSize: 14, color: colors.text, fontWeight: '600' },
  pct: { fontSize: 14, color: colors.muted, fontVariant: ['tabular-nums'] },
  detail: { fontSize: 12, color: colors.muted },
  footer: { alignItems: 'center', gap: 6 },
  tip: { fontSize: 13, color: colors.muted, textAlign: 'center' },
  model: { fontSize: 12, color: colors.muted, opacity: 0.7 },
});

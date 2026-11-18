/**
 * 왼쪽에서 밀려 나오는 서랍 (대화 목록용).
 * - 열 때 왼쪽→오른쪽으로 나오고, 뒤 화면은 어둡게 덮는다
 * - 어두운 곳을 누르거나, 서랍을 왼쪽으로 밀면 닫힌다
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, PanResponder, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { colors } from './theme';

export function LeftDrawer({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  const { width } = useWindowDimensions();
  const drawerW = Math.min(420, Math.round(width * 0.86));
  const [mounted, setMounted] = useState(visible);
  const x = useRef(new Animated.Value(-drawerW)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      x.setValue(-drawerW);
      Animated.timing(x, { toValue: 0, duration: 230, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else {
      Animated.timing(x, { toValue: -drawerW, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(
        () => setMounted(false),
      );
    }
    // drawerW 는 회전할 때만 바뀐다. 열림 상태가 바뀔 때만 움직인다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // 서랍을 왼쪽으로 밀어 닫기
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => g.dx < -12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_, g) => x.setValue(Math.min(0, g.dx)),
        onPanResponderRelease: (_, g) => {
          if (g.dx < -drawerW * 0.3 || g.vx < -0.5) onClose();
          else Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        },
        onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(),
      }),
    [x, drawerW, onClose],
  );

  if (!mounted) return null;
  const dim = x.interpolate({ inputRange: [-drawerW, 0], outputRange: [0, 1], extrapolate: 'clamp' });

  return (
    <Modal
      transparent
      visible
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
    >
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: dim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="대화 목록 닫기" />
      </Animated.View>
      <Animated.View {...pan.panHandlers} style={[styles.drawer, { width: drawerW, transform: [{ translateX: x }] }]}>
        {children}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.bg,
    borderTopRightRadius: 22,
    borderBottomRightRadius: 22,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 4, height: 0 },
    elevation: 16,
  },
});

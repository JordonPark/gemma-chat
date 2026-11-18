import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { FoldAwareArea } from './FoldAwareArea';
import { getFoldInsets } from './foldLayout';
import { boundImage, fitImage, MAX_IMAGE_ZOOM, zoomImage, type ImageTransform } from './imageZoom';
import { AnnotationLayer, Chip, type AnnotationView } from './AnnotatedPhoto';
import type { PhotoAnnotations } from './photoAnnotate';

/** annot 가 있으면 확대해도 같은 자리에 글자 번역·물건 상자를 그린다 */
export type ImagePreview = { title: string; uri: string; annot?: PhotoAnnotations } & Partial<AnnotationView>;

const CENTER = { x: 0, y: 0 };
const FITTED = { ...CENTER, scale: 1 };

function sampleTouches(event: GestureResponderEvent) {
  const [first, second] = event.nativeEvent.touches;
  if (!first) return null;
  if (!second) return { x: first.locationX, y: first.locationY, distance: 0, fingers: String(first.identifier) };
  return {
    x: (first.locationX + second.locationX) / 2,
    y: (first.locationY + second.locationY) / 2,
    distance: Math.hypot(first.locationX - second.locationX, first.locationY - second.locationY),
    fingers: [first.identifier, second.identifier].sort().join(','),
  };
}

export function ImageViewer({ media, onClose }: { media: ImagePreview; onClose: () => void }) {
  const [view, setView] = useState<AnnotationView>({
    showTranslation: media.showTranslation ?? true,
    showObjects: media.showObjects ?? true,
  });
  const annot = media.annot;
  const hasTranslation = !!annot?.translations?.some((t) => t);
  return (
    <Modal animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.screen}>
          <StatusBar style="light" />
          <FoldAwareArea>
            {(size, division) => {
              const insets = getFoldInsets(size, division);
              return (
                <View style={[styles.content, {
                  marginLeft: insets.left,
                  marginRight: insets.right,
                  marginTop: insets.top,
                  marginBottom: insets.bottom,
                }]}>
                  <View style={styles.header}>
                    <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{media.title}</Text>
                    <Pressable style={styles.control} accessibilityRole="button" onPress={onClose}>
                      <Text style={styles.controlText}>닫기</Text>
                    </Pressable>
                  </View>
                  {annot && (hasTranslation || annot.objects.length) ? (
                    <View style={styles.annotBar}>
                      {hasTranslation ? (
                        <Chip
                          label={view.showTranslation ? '원문 보기' : '번역 보기'}
                          onPress={() => setView((v) => ({ ...v, showTranslation: !v.showTranslation }))}
                        />
                      ) : null}
                      {annot.objects.length ? (
                        <Chip
                          label={view.showObjects ? '물건 표시 끄기' : '물건 표시'}
                          onPress={() => setView((v) => ({ ...v, showObjects: !v.showObjects }))}
                        />
                      ) : null}
                    </View>
                  ) : null}
                  <ZoomableImage media={media} view={view} />
                </View>
              );
            }}
          </FoldAwareArea>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

type TouchSample = NonNullable<ReturnType<typeof sampleTouches>>;

function ZoomableImage({ media, view }: { media: ImagePreview; view: AnnotationView }) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [animated] = useState(() => ({
    x: new Animated.Value(0),
    y: new Animated.Value(0),
    scale: new Animated.Value(1),
  }));
  const pose = useRef<ImageTransform>(FITTED);
  const gesture = useRef<{ start: TouchSample; pose: ImageTransform } | null>(null);
  const fitted = useMemo(() => fitImage(viewport, imageSize), [viewport, imageSize]);

  const apply = useCallback((transform: ImageTransform) => {
    const next = boundImage(transform, fitted, viewport);
    pose.current = next;
    animated.x.setValue(next.x);
    animated.y.setValue(next.y);
    animated.scale.setValue(next.scale);
  }, [fitted, viewport, animated]);

  useEffect(() => {
    gesture.current = null;
    apply(pose.current);
  }, [apply]);

  const shouldCaptureGesture = (event: GestureResponderEvent) =>
    !broken && (event.nativeEvent.touches.length >= 2 || pose.current.scale > 1);

  const beginGesture = (event: GestureResponderEvent) => {
    const touch = sampleTouches(event);
    gesture.current = touch ? { start: touch, pose: pose.current } : null;
  };

  const moveGesture = (event: GestureResponderEvent) => {
    const touch = sampleTouches(event);
    if (!touch) return;
    let baseline = gesture.current;
    if (!baseline || baseline.start.fingers !== touch.fingers) {
      baseline = { start: touch, pose: pose.current };
      gesture.current = baseline;
    }
    const anchor = {
      x: baseline.start.x - viewport.width / 2,
      y: baseline.start.y - viewport.height / 2,
    };
    const current = { x: touch.x - viewport.width / 2, y: touch.y - viewport.height / 2 };
    const scale = baseline.start.distance > 0
      ? baseline.pose.scale * (touch.distance / baseline.start.distance)
      : baseline.pose.scale;
    apply(zoomImage(baseline.pose, scale, anchor, current));
  };

  const finishGesture = () => {
    gesture.current = null;
    setZoom(pose.current.scale);
  };

  const changeZoom = (amount: number) => {
    apply(zoomImage(pose.current, pose.current.scale + amount, CENTER));
    setZoom(pose.current.scale);
  };

  const reset = () => {
    apply(FITTED);
    setZoom(1);
  };

  return (
    <>
      <View
        style={styles.viewport}
        onLayout={({ nativeEvent: { layout: { width, height } } }) => {
          setViewport((previous) => previous.width === width && previous.height === height ? previous : { width, height });
        }}
        onStartShouldSetResponder={shouldCaptureGesture}
        onMoveShouldSetResponder={shouldCaptureGesture}
        onResponderGrant={beginGesture}
        onResponderStart={beginGesture}
        onResponderEnd={beginGesture}
        onResponderMove={moveGesture}
        onResponderRelease={finishGesture}
        onResponderTerminate={finishGesture}
      >
        {broken ? (
          <Text style={styles.error}>이미지를 불러올 수 없습니다.</Text>
        ) : (
          <Animated.View
            pointerEvents="none"
            style={[fitted, {
              transform: [{ translateX: animated.x }, { translateY: animated.y }, { scale: animated.scale }],
            }]}
          >
            <Image
                source={{ uri: media.uri }}
                style={styles.image}
                resizeMode="contain"
                onLoad={({ nativeEvent: { source } }) => {
                  if (source?.width > 0 && source.height > 0) {
                    setImageSize({ width: source.width, height: source.height });
                  }
                }}
                onError={() => setBroken(true)}
              />
            {/* 사진과 같은 확대·이동 층 안에 그려 확대해도 상자 위치가 맞는다 */}
            {media.annot && imageSize ? (
              <AnnotationLayer annot={media.annot} width={fitted.width} height={fitted.height} {...view} />
            ) : null}
          </Animated.View>
        )}
      </View>
      {!broken ? (
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="축소"
            disabled={zoom <= 1}
            style={[styles.control, zoom <= 1 && styles.disabled]}
            onPress={() => changeZoom(-0.5)}
          >
            <Text style={styles.sign}>−</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="화면에 맞추기" style={styles.control} onPress={reset}>
            <Text style={styles.controlText}>{Math.round(zoom * 100)}%</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="확대"
            disabled={zoom >= MAX_IMAGE_ZOOM}
            style={[styles.control, zoom >= MAX_IMAGE_ZOOM && styles.disabled]}
            onPress={() => changeZoom(0.5)}
          >
            <Text style={styles.sign}>+</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#111018' },
  content: { flex: 1, minHeight: 0, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  annotBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  title: { flex: 1, color: '#F7F2FF', fontSize: 17, fontWeight: '700' },
  viewport: { flex: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  controls: { flexDirection: 'row', justifyContent: 'center', gap: 8, padding: 10 },
  control: {
    minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 12, borderRadius: 12, backgroundColor: '#2D273C',
  },
  controlText: { color: '#F7F2FF', fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sign: { color: '#F7F2FF', fontSize: 23 },
  disabled: { opacity: 0.45 },
  error: { color: '#F7F2FF', textAlign: 'center', paddingHorizontal: 16 },
});

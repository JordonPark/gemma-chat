/**
 * 사진 위에 표시하기:
 *  - 물건: 네모 상자 + 위(공간이 없으면 안쪽)에 한국어 이름
 *  - 글자: 번역 보기면 외국어 줄 자리에 한국어 번역을 덮어 쓰고(구글 렌즈처럼), 원문 보기면 글자 위치만 얇게 표시
 * 아래 버튼으로 번역/원문, 물건 표시를 켜고 끈다.
 */
import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PhotoAnnotations } from './photoAnnotate';

type Props = {
  uri: string;
  /** 표시할 최대 너비 */
  width: number;
  annot: PhotoAnnotations;
  translating?: boolean;
  /** 크게 보기: 지금 보고 있는 표시 상태(번역/물건)를 그대로 넘긴다 */
  onOpen?: (uri: string, view: AnnotationView) => void;
};

export type AnnotationView = { showTranslation: boolean; showObjects: boolean };

export function AnnotatedPhoto({ uri, width, annot, translating, onOpen }: Props) {
  const [aspect, setAspect] = useState<number | null>(null); // 높이 / 너비
  const hasTranslation = !!annot.translations?.some((t) => t);
  const [showTranslation, setShowTranslation] = useState(true);
  const [showObjects, setShowObjects] = useState(true);

  useEffect(() => {
    let alive = true;
    Image.getSize(
      uri,
      (w, h) => alive && w > 0 && setAspect(h / w),
      () => alive && setAspect(1),
    );
    return () => {
      alive = false;
    };
  }, [uri]);

  // 너무 긴 사진은 높이를 줄여 화면을 다 덮지 않게 한다 (상자 위치가 맞도록 비율은 유지)
  const a = aspect ?? 1;
  let W = width;
  let H = W * a;
  if (H > width * 1.4) {
    H = width * 1.4;
    W = H / a;
  }

  return (
    <View style={{ gap: 8, marginBottom: 8 }}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel="첨부 사진 크게 보기"
        onPress={() => onOpen?.(uri, { showTranslation, showObjects })}
        style={[styles.frame, { width: W, height: H }]}
      >
        <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />

        <AnnotationLayer annot={annot} width={W} height={H} showTranslation={showTranslation} showObjects={showObjects} />
      </Pressable>

      <View style={styles.chips}>
        {translating ? <Text style={styles.status}>사진 속 글자 번역 중…</Text> : null}
        {hasTranslation ? (
          <Chip label={showTranslation ? '원문 보기' : '번역 보기'} onPress={() => setShowTranslation((v) => !v)} />
        ) : null}
        {annot.objects.length ? (
          <Chip
            label={showObjects ? `물건 표시 끄기 (${annot.objects.length})` : `물건 표시 (${annot.objects.length})`}
            onPress={() => setShowObjects((v) => !v)}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * 사진 위 표시 층 (작은 미리보기와 크게 보기에서 함께 쓴다). width·height 는 사진이 실제로 그려진 크기.
 * 크게 보기에서는 사진과 같은 확대·이동 층 안에 두어 확대해도 위치가 맞는다.
 */
export function AnnotationLayer({
  annot,
  width: W,
  height: H,
  showTranslation,
  showObjects,
}: { annot: PhotoAnnotations; width: number; height: number } & AnnotationView) {
  const hasTranslation = !!annot.translations?.some((t) => t);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {annot.lines.map((l, i) => {
        const tr = annot.translations?.[i];
        const left = l.box.x * W;
        const top = l.box.y * H;
        const w = Math.max(12, l.box.width * W);
        const h = Math.max(10, l.box.height * H);
        if (showTranslation && tr) {
          // 글자 크기는 줄 높이와 너비 둘 다에 맞춘다 (세로로 쓴 글자처럼 좁고 긴 상자에서 너무 커지지 않게, 최대 2줄)
          const byWidth = ((w + 4) * 2) / Math.max(2, Array.from(tr).length);
          const fontSize = Math.max(8, Math.min(22, h * 0.72, byWidth));
          return (
            <View key={`t${i}`} style={[styles.trBox, { left: left - 2, top: top - 1, minWidth: w + 4, minHeight: h + 2 }]}>
              <Text style={[styles.trText, { fontSize, lineHeight: fontSize * 1.2 }]} numberOfLines={2}>
                {tr}
              </Text>
            </View>
          );
        }
        return !showTranslation || !hasTranslation ? (
          <View key={`b${i}`} style={[styles.textBox, { left, top, width: w, height: h }]} />
        ) : null;
      })}
      {showObjects &&
        annot.objects.map((o, i) => {
          const left = o.box.x * W;
          const top = o.box.y * H;
          return (
            <View key={`o${i}`} style={[styles.objBox, { left, top, width: o.box.width * W, height: o.box.height * H }]}>
              <Text style={[styles.objLabel, top < 20 ? styles.labelInside : styles.labelAbove]} numberOfLines={1}>
                {o.label}
              </Text>
            </View>
          );
        })}
    </View>
  );
}

export function Chip({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.chip} hitSlop={6}>
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },
  textBox: { position: 'absolute', borderWidth: 1, borderColor: 'rgba(255, 214, 0, 0.9)', borderRadius: 2 },
  trBox: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 255, 255, 0.93)',
    borderRadius: 3,
    paddingHorizontal: 2,
    justifyContent: 'center',
  },
  trText: { color: '#111', fontWeight: '600' },
  objBox: { position: 'absolute', borderWidth: 2, borderColor: '#8B5CF6', borderRadius: 4 },
  objLabel: {
    position: 'absolute',
    left: -2,
    backgroundColor: '#8B5CF6',
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
    maxWidth: 160,
  },
  labelAbove: { bottom: '100%', marginBottom: 2 },
  labelInside: { top: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  chipText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  status: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
});

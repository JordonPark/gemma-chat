/**
 * Gemma 가 그린 SVG 일러스트 카드. PNG 로 바꿔 공유하거나 사진 앱에 저장할 수 있다.
 */
import { memo, useRef, useState, type ComponentRef } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { colors } from './theme';

type Props = { svg: string; size?: number; live?: boolean; caption?: string; onOpen?: (svg: string) => void };

export const SvgCard = memo(function SvgCard({ svg, size = 260, live = false, caption, onOpen }: Props) {
  const shotRef = useRef<ComponentRef<typeof View>>(null);
  const [broken, setBroken] = useState(false);

  const share = async () => {
    try {
      const uri = await captureRef(shotRef, { format: 'png', quality: 1, width: 1024, height: 1024 });
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('공유', '이 기기에서는 공유를 사용할 수 없습니다.');
        return;
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: '일러스트 저장·공유', UTI: 'public.png' });
    } catch (e: any) {
      Alert.alert('저장·공유 실패', String(e?.message ?? e));
    }
  };

  const canvas = (
    <View ref={shotRef} collapsable={false} style={[styles.canvas, { width: size, height: size }]}>
      {broken ? (
        <Text style={styles.broken}>그림을 표시하지 못했습니다.{'\n'}다시 그려 보세요.</Text>
      ) : (
        <SvgXml xml={svg} width="100%" height="100%" onError={() => !live && setBroken(true)} />
      )}
    </View>
  );

  return (
    <View style={styles.wrap}>
      {onOpen && !live && !broken ? (
        <Pressable accessibilityRole="button" accessibilityLabel="일러스트 크게 보기" onPress={() => onOpen(svg)}>
          {canvas}
        </Pressable>
      ) : canvas}
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      {!live && !broken ? (
        <Pressable onPress={share} style={styles.btn}>
          <Text style={styles.btnText}>저장 · 공유</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  canvas: { borderRadius: 12, overflow: 'hidden', backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' },
  broken: { color: '#666', textAlign: 'center', fontSize: 13 },
  caption: { fontSize: 12, color: colors.muted },
  btn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.border,
  },
  btnText: { color: colors.text, fontSize: 13, fontWeight: '600' },
});

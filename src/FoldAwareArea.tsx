import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { FoldObserver, type AreaSize, type FoldGeometry } from '../modules/gemma-fold';
import { getDivision, type Division } from './foldLayout';

export function FoldAwareArea({
  children,
}: {
  children: (size: AreaSize, division: Division | null) => ReactNode;
}) {
  const [size, setSize] = useState<AreaSize>({ width: 0, height: 0 });
  const [geometry, setGeometry] = useState<FoldGeometry | null>(null);

  return (
    <View
      style={styles.area}
      onLayout={({ nativeEvent: { layout: { width, height } } }) => {
        setSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
      }}
    >
      {FoldObserver ? (
        <FoldObserver
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
          accessible={false}
          onGeometryChange={({ nativeEvent }) => setGeometry(nativeEvent)}
        />
      ) : null}
      {children(size, getDivision(size, geometry))}
    </View>
  );
}

const styles = StyleSheet.create({
  area: { flex: 1, minHeight: 0 },
});

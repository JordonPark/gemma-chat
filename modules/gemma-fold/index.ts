import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { Platform, type NativeSyntheticEvent, type ViewProps } from 'react-native';

export type AreaSize = { width: number; height: number };
export type FoldGeometry = AreaSize & {
  division?: AreaSize & { x: number; y: number };
};

type ObserverProps = ViewProps & {
  onGeometryChange: (event: NativeSyntheticEvent<FoldGeometry>) => void;
};

export const FoldObserver =
  Platform.OS === 'ios' && parseFloat(String(Platform.Version)) >= 27.1 && requireOptionalNativeModule('GemmaFold')
    ? requireNativeViewManager<ObserverProps>('GemmaFold')
    : null;

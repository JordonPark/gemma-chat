import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform, StyleSheet } from 'react-native';
import type { DuoToolbarProps } from './DuoToolbar';
import { APP_NAME } from './storeConfig';
import { colors } from './theme';

export const hasDuoToolbar = Platform.OS === 'ios' && !Platform.isPad && parseFloat(String(Platform.Version)) >= 27.1
  && requireOptionalNativeModule('ExpoUI') !== null;

export function DuoToolbar({ children, busy, onLibrary, onNewChat, onSettings }: DuoToolbarProps) {
  if (!hasDuoToolbar) return children;

  // Load the native view definitions only once this build has the SwiftUI module.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { Host, NavigationStack, RNHostView, Toolbar, ToolbarItem, Button } =
    require('@expo/ui/swift-ui') as typeof import('@expo/ui/swift-ui');
  const { disabled, navigationBarTitleDisplayMode, navigationTitle } =
    require('@expo/ui/swift-ui/modifiers') as typeof import('@expo/ui/swift-ui/modifiers');
  /* eslint-enable @typescript-eslint/no-require-imports */

  return (
    <Host style={styles.host} seedColor={colors.accentText}>
      <NavigationStack>
        <Toolbar modifiers={[navigationTitle(APP_NAME), navigationBarTitleDisplayMode('inline')]}>
          <RNHostView>{children}</RNHostView>
          <Toolbar.Content>
            <ToolbarItem placement="topBarPinnedTrailing" visibilityPriority="high">
              <Button label="대화와 테스크" systemImage="sidebar.left" onPress={onLibrary} />
            </ToolbarItem>
            <ToolbarItem placement="topBarTrailing">
              <Button label="새 대화" systemImage="square.and.pencil" onPress={onNewChat} modifiers={[disabled(busy)]} />
            </ToolbarItem>
            <ToolbarItem placement="topBarTrailing">
              <Button label="설정" systemImage="gearshape" onPress={onSettings} modifiers={[disabled(busy)]} />
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>
      </NavigationStack>
    </Host>
  );
}

const styles = StyleSheet.create({ host: { flex: 1 } });

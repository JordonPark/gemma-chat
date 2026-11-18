import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ChatScreen } from './src/ChatScreen';
import { FoldAwareArea } from './src/FoldAwareArea';
import { getFoldInsets } from './src/foldLayout';
import { LoadingScreen } from './src/LoadingScreen';
import { SetupScreen } from './src/SetupScreen';
import { loadModel, unloadModel, type Settings } from './src/llm';
import { deleteInstalledModels, findInstalledModel, type InstalledModel } from './src/modelStore';
import { loadSettings, saveSettings } from './src/storage';
import { colors, isDark } from './src/theme';

type Phase =
  | { kind: 'scanning' }
  | { kind: 'setup' }
  | { kind: 'loading'; model: InstalledModel; pct: number }
  | { kind: 'ready'; model: InstalledModel; gpuInfo: string }
  | { kind: 'error'; model: InstalledModel; message: string };

// 첫 실행 때 로딩 화면을 최소 이만큼은 보여 준다 (모델이 빨리 올라와도 화면이 깜빡이고 지나가지 않게)
const MIN_SPLASH_MS = 2500;

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' });
  const launchAt = useRef(Date.now());
  const firstLaunch = useRef(true);

  /** 첫 실행이면 로딩 화면이 MIN_SPLASH_MS 동안 보이도록 남은 시간만큼 기다린다 */
  const holdSplash = useCallback(async () => {
    if (!firstLaunch.current) return;
    firstLaunch.current = false;
    const wait = MIN_SPLASH_MS - (Date.now() - launchAt.current);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }, []);

  const startModel = useCallback(
    async (model: InstalledModel, s: Settings) => {
      setPhase({ kind: 'loading', model, pct: 0 });
      try {
        const r = await loadModel(model.path, s, (pct) => setPhase({ kind: 'loading', model, pct }));
        const gpuInfo = r.gpu ? 'GPU' : s.useGpu ? `CPU (GPU 불가: ${r.reasonNoGPU || '미지원'})` : 'CPU';
        setPhase({ kind: 'loading', model, pct: 100 });
        await holdSplash();
        setPhase({ kind: 'ready', model, gpuInfo });
      } catch (e: any) {
        firstLaunch.current = false;
        setPhase({ kind: 'error', model, message: String(e?.message ?? e) });
      }
    },
    [holdSplash],
  );

  useEffect(() => {
    (async () => {
      const m = await findInstalledModel();
      if (m) startModel(m, settings);
      else {
        await holdSplash();
        setPhase({ kind: 'setup' });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeModel = async () => {
    await unloadModel();
    await deleteInstalledModels();
    setPhase({ kind: 'setup' });
  };

  const changeSettings = (s: Settings) => {
    const needReload = s.nCtx !== settings.nCtx || s.useGpu !== settings.useGpu;
    setSettings(s);
    saveSettings(s);
    if (needReload && (phase.kind === 'ready' || phase.kind === 'error')) startModel(phase.model, s);
  };

  let body: React.ReactNode;
  switch (phase.kind) {
    case 'scanning':
      body = <LoadingScreen status="준비 중" />;
      break;
    case 'setup':
      body = <SetupScreen onInstalled={(m) => startModel(m, settings)} />;
      break;
    case 'loading':
      body = (
        <LoadingScreen
          pct={phase.pct}
          status={phase.pct >= 100 ? '준비 완료' : '모델 불러오는 중'}
          detail={phase.model.name}
        />
      );
      break;
    case 'error':
      body = (
        <Center>
          <Text style={[styles.text, { fontWeight: '700' }]}>모델을 불러오지 못했습니다</Text>
          <Text style={styles.muted}>{phase.message}</Text>
          <Text style={styles.muted}>메모리가 부족하면 GPU를 끄거나 컨텍스트 길이를 줄여 보세요.</Text>
          <Pressable style={styles.btn} onPress={() => changeSettings({ ...settings, useGpu: false, nCtx: 2048 })}>
            <Text style={styles.btnText}>CPU · n_ctx 2048 로 다시 시도</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, { backgroundColor: colors.danger }]}
            onPress={() =>
              Alert.alert('모델 삭제', '설치된 모델을 지우고 다시 설치하시겠습니까?', [
                { text: '취소', style: 'cancel' },
                { text: '삭제', style: 'destructive', onPress: removeModel },
              ])
            }
          >
            <Text style={styles.btnText}>모델 다시 설치</Text>
          </Pressable>
        </Center>
      );
      break;
    case 'ready':
      body = (
        <ChatScreen
          model={phase.model}
          settings={settings}
          gpuInfo={phase.gpuInfo}
          onChangeSettings={changeSettings}
          onRemoveModel={removeModel}
        />
      );
      break;
  }

  return (
    <SafeAreaProvider>
      <View style={[styles.flex, { backgroundColor: colors.bg }]}>
        {phase.kind === 'ready' ? body : (
          <SafeAreaView style={styles.flex}>
            <FoldAwareArea>
              {(size, division) => {
                const insets = getFoldInsets(size, division);
                return (
                  <View style={[styles.flex, {
                    marginLeft: insets.left,
                    marginRight: insets.right,
                    marginTop: insets.top,
                    marginBottom: insets.bottom,
                  }]}>
                    {body}
                  </View>
                );
              }}
            </FoldAwareArea>
          </SafeAreaView>
        )}
        <StatusBar style={isDark ? 'light' : 'dark'} />
      </View>
    </SafeAreaProvider>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <ScrollView contentContainerStyle={styles.center}>{children}</ScrollView>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  text: { fontSize: 16, color: colors.text, textAlign: 'center' },
  muted: { fontSize: 13, color: colors.muted, textAlign: 'center' },
  btn: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18 },
  btnText: { color: '#fff', fontWeight: '600' },
});

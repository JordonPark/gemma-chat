import type { ExpoConfig } from 'expo/config';

/**
 * 오프라인 전용 빌드 설정.
 *
 * - 기본(릴리스) 빌드는 Android INTERNET 권한을 제거해 네트워크를 원천 차단한다.
 * - 개발 중 Metro(JS 번들 서버)에 붙어야 할 때만 APP_VARIANT=development 로 빌드한다.
 *     APP_VARIANT=development npx expo run:android
 */
const isDev = process.env.APP_VARIANT === 'development';

const config: ExpoConfig = {
  name: 'Gemma Chat',
  slug: 'gemma-chat',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'com.jordonpark.gemmachat',
    supportsTablet: true,
    infoPlist: {
      // Finder(맥) / 파일 앱에서 앱의 Documents 폴더에 모델 파일을 직접 넣을 수 있게 한다.
      UIFileSharingEnabled: true,
      LSSupportsOpeningDocumentsInPlace: true,
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'com.jordonpark.gemmachat',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    blockedPermissions: isDev ? [] : ['android.permission.INTERNET'],
  },
  plugins: [
    [
      'expo-build-properties',
      {
        android: {
          // llama.rn 프리빌트 라이브러리는 arm64-v8a / x86_64 대상
          buildArchs: ['arm64-v8a', 'x86_64'],
          extraProguardRules: '-keep class com.rnllama.** { *; }',
        },
      },
    ],
    [
      'llama.rn',
      {
        // increased-memory-limit 등 엔타이틀먼트 (유료 Apple 개발자 계정 필요)
        enableEntitlements: true,
        // Android: Adreno GPU(OpenCL) 사용 가능하도록 libOpenCL.so 선언
        enableOpenCLAndHexagon: true,
      },
    ],
  ],
};

export default config;

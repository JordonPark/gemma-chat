import type { ExpoConfig } from 'expo/config';

/**
 * 앱 설정.
 *
 * 네트워크는 최초 1회 모델 다운로드(GitHub Release)에만 쓴다. 채팅(추론)은 기기 안에서만 처리한다.
 *
 * 완전 오프라인 빌드(INTERNET 권한 제거, 모델은 파일로만 설치)가 필요하면:
 *     OFFLINE_ONLY=1 npx expo run:android --variant release
 */
const offlineOnly = process.env.OFFLINE_ONLY === '1';

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
    blockedPermissions: offlineOnly ? ['android.permission.INTERNET'] : [],
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

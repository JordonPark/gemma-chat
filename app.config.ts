import type { ExpoConfig } from 'expo/config';

/**
 * 앱 설정.
 *
 * 네트워크는 최초 1회 모델 다운로드(GitHub Release)에만 쓴다. 채팅(추론)은 기기 안에서만 처리한다.
 *
 * 완전 오프라인 빌드(INTERNET 권한 제거, 모델은 파일로만 설치)가 필요하면:
 *     OFFLINE_ONLY=1 npx expo run:android --variant release
 *
 * OTA 업데이트(expo-updates + EAS Update):
 *   EXPO_PROJECT_ID(expo.dev 프로젝트 ID)가 있으면 켜진다. JS(화면·로직) 변경은 .ipa/.apk 를 다시
 *   설치하지 않고 앱이 Wi-Fi 에서 켜질 때 받아 다음 실행에 적용한다.
 *   네이티브(라이브러리 추가, 권한, 이 파일의 설정 등)를 바꾸면 version 을 올리고 앱을 새로 빌드해야 한다
 *   (runtimeVersion = version 이라 버전이 다른 앱에는 업데이트가 가지 않는다).
 */
const offlineOnly = process.env.OFFLINE_ONLY === '1';
const easProjectId = process.env.EXPO_PROJECT_ID?.trim() || undefined;
const otaEnabled = !!easProjectId && !offlineOnly;

const config: ExpoConfig = {
  name: 'Gemma Chat',
  slug: 'gemma-chat',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  runtimeVersion: { policy: 'appVersion' },
  updates: otaEnabled
    ? {
        enabled: true,
        url: `https://u.expo.dev/${easProjectId}`,
        checkAutomatically: 'WIFI_ONLY', // 모바일 데이터에서는 업데이트를 확인하지 않는다
        fallbackToCacheTimeout: 0, // 시작을 기다리게 하지 않음: 받아 두었다가 다음 실행에 적용
        requestHeaders: { 'expo-channel-name': 'production' },
      }
    : { enabled: false },
  extra: easProjectId ? { eas: { projectId: easProjectId } } : {},
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
          // 실제 휴대폰은 모두 arm64. (에뮬레이터용 x86_64 를 빼서 APK 크기·빌드 시간 절약)
          buildArchs: ['arm64-v8a'],
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

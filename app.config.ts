import type { ExpoConfig } from 'expo/config';
import release from './src/appRelease.json';

/**
 * 앱 설정.
 *
 * 채팅(추론)은 기기에서 처리한다. 네트워크는 모델 다운로드, 테스트 OTA, 사용자가 보내는 신고에 사용한다.
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
// expo.dev 프로젝트가 팀(조직) 계정 아래에 있으면 그 계정 이름 (예: jusuns-team)
const easOwner = process.env.EXPO_OWNER?.trim() || undefined;
const storeBuild = process.env.EXPO_PUBLIC_STORE_BUILD === '1';
const supportUrl = process.env.EXPO_PUBLIC_SUPPORT_BASE_URL?.trim();

if (storeBuild || supportUrl) {
  const url = supportUrl ? new URL(supportUrl) : null;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Set EXPO_PUBLIC_SUPPORT_BASE_URL to the HTTPS origin of the privacy and reporting service.');
  }
}

const otaEnabled = !!easProjectId && !offlineOnly && !storeBuild;

const config: ExpoConfig = {
  name: storeBuild ? (process.env.EXPO_PUBLIC_STORE_NAME?.trim() || 'My Buddy') : 'Gemma Chat',
  slug: 'gemma-chat',
  ...(easOwner ? { owner: easOwner } : {}),
  // 네이티브 변경(라이브러리·권한) 때마다 올린다 → OTA 업데이트가 맞는 앱에만 간다
  // 1.1.0: 카메라·사진(expo-image-picker, expo-image-manipulator) 추가
  // 1.2.0: SVG 일러스트(react-native-svg), PNG 저장·공유(react-native-view-shot, expo-sharing)
  // 1.3.0: 기기 OCR 모듈(modules/expo-ocr: iOS Apple Vision, Android ML Kit 한국어)
  // 1.4.0: iOS 기기 그림 생성 모듈(modules/expo-sd: Apple Core ML Stable Diffusion)
  // 1.5.0: iPhone Duo 접힘 영역 및 iOS 가로 화면 지원
  // 1.6.0: 스토어 빌드 및 iOS 그림 안전 검사 필수화
  version: release.version,
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
    ...(storeBuild ? { buildNumber: '1' } : {}),
    infoPlist: {
      UISupportedInterfaceOrientations: [
        'UIInterfaceOrientationPortrait',
        'UIInterfaceOrientationLandscapeLeft',
        'UIInterfaceOrientationLandscapeRight',
      ],
      'UISupportedInterfaceOrientations~ipad': [
        'UIInterfaceOrientationPortrait',
        'UIInterfaceOrientationPortraitUpsideDown',
        'UIInterfaceOrientationLandscapeLeft',
        'UIInterfaceOrientationLandscapeRight',
      ],
      // Finder(맥) / 파일 앱에서 앱의 Documents 폴더에 모델 파일을 직접 넣을 수 있게 한다.
      UIFileSharingEnabled: true,
      LSSupportsOpeningDocumentsInPlace: true,
      ITSAppUsesNonExemptEncryption: false,
      // 공유 시트의 "이미지 저장"으로 일러스트를 사진 앱에 저장할 때 필요
      NSPhotoLibraryAddUsageDescription: '그린 일러스트를 사진 앱에 저장합니다.',
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
    ...(storeBuild ? { versionCode: 16, allowBackup: false } : {}),
    blockedPermissions: [
      ...(offlineOnly ? ['android.permission.INTERNET'] : []),
      ...(storeBuild ? [
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ] : []),
    ],
  },
  plugins: [
    [
      'expo-image-picker',
      {
        cameraPermission: '사진을 찍어 기기 안에서 물체·글자를 인식하는 데 사용합니다. 사진은 기기 밖으로 나가지 않습니다.',
        photosPermission: '앨범의 사진을 기기 안에서 인식하는 데 사용합니다. 사진은 기기 밖으로 나가지 않습니다.',
        microphonePermission: false,
      },
    ],
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

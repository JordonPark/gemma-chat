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
  //        이후 그림 그리기 기능과 modules/expo-sd 제거 (JS 는 기존 1.6.0 빌드와도 호환)
  // 1.7.0: iOS 27.1 기본 탐색 막대 및 iPhone Duo 세로 도구 버튼
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
    // 스토어 빌드 번호는 EAS 가 올린다 (eas.json: appVersionSource remote + autoIncrement). 여기 값은 처음 한 번만 쓰이는 시작값
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
      // Finder(맥) / 파일 앱에서 앱의 Documents 폴더에 모델 파일을 직접 넣을 수 있게 한다 (개발·테스트 빌드만).
      // 스토어 빌드는 앱 내부 폴더(대화 사진·기억 등)를 파일 앱에 드러내지 않는다.
      ...(storeBuild ? {} : { UIFileSharingEnabled: true, LSSupportsOpeningDocumentsInPlace: true }),
      ITSAppUsesNonExemptEncryption: false,
    },
    // Apple 개인정보 매니페스트: 앱과 llama.rn 이 쓰는 "사용 이유 필요 API" 와 수집 데이터 선언.
    // 수집하는 것은 사용자가 직접 보내는 신고 내용(답변 텍스트)뿐이며, 사용자와 연결하거나 추적하지 않는다.
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyAccessedAPITypes: [
        // 모델·사진 파일 크기·수정 시각 확인 (앱 컨테이너 안 파일)
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
        // 수 GB 모델을 받기 전에 남은 공간 확인 / 저장 공간 화면에 표시
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'] },
        // 생성 속도(tok/s)·경과 시간 측정
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
        // 앱 설정 저장 (React Native)
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
      ],
      NSPrivacyCollectedDataTypes: [
        {
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeOtherUserContent',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
      ],
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
    // versionCode 도 EAS 가 스토어 빌드마다 올린다 (여기 16 은 시작값)
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

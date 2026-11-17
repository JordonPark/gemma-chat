# Gemma Chat — 오프라인 온디바이스 챗봇 (Android / iOS)

`google/gemma-3-4b-it-qat-q4_0-gguf` 모델을 **기기 안에서만** 실행하는 챗봇 앱입니다.

- **네트워크 미사용**: Android 릴리스 빌드에서는 `INTERNET` 권한 자체를 제거합니다. 앱 코드에도 네트워크 호출이 없습니다.
- **모델 배포**: PC에서 git(Hugging Face git 저장소 → GitHub Release/LFS)으로 받은 분할 파일을 기기로 옮기면, 앱이 **기기 안에서 이어 붙이고(zip이면 압축 해제) SHA-256으로 검증한 뒤 설치**합니다.
- **추론 엔진**: [llama.rn](https://github.com/mybigday/llama.rn)(llama.cpp). iOS는 Metal GPU를 쓰고, Android는 CPU를 쓰거나 Adreno OpenCL GPU를 선택해서 켤 수 있습니다.
- **스택**: Expo SDK 58(React Native 0.88, New Architecture), TypeScript

```
┌─ PC ─────────────────────────────────────────┐        ┌─ 기기 (오프라인) ───────────────────────────┐
│ git clone (HF) + git lfs pull                │        │ 파일 선택 / Finder 로 넣기                  │
│   → tools/split_model.py 로 1.9GB 조각 분할  │ ─USB─▶ │   → 조각 이어 붙이기 (8MiB 스트리밍)        │
│   → SHA256SUMS 생성                          │ AirDrop│   → (zip이면) 압축 해제                     │
│   → (선택) GitHub Release 에 업로드          │        │   → SHA-256 검증 → Documents/models/*.gguf  │
└──────────────────────────────────────────────┘        │   → llama.cpp 로드 → 채팅                   │
                                                        └─────────────────────────────────────────────┘
```

## 1. 모델 준비 (PC에서 한 번)

필요한 것: `git`, `git-lfs`, `python3`, 그리고 Hugging Face에서 Gemma 라이선스에 동의한 계정의 read 토큰.

```bash
git lfs install
```

```bash
npm run pack-model
```

Windows에서는 **Git for Windows**(git-lfs 포함)와 **Python 3**을 설치한 뒤, 저장소 폴더에서 **Git Bash**를 열고 실행합니다. Node.js가 없어도 됩니다.

```bash
bash tools/pack_model.sh
```

`tools/pack_model.sh`는 다음을 실행합니다.
1. `GIT_LFS_SKIP_SMUDGE=1 git clone https://huggingface.co/google/gemma-3-4b-it-qat-q4_0-gguf model-src`
2. `git lfs pull --include gemma-3-4b-it-q4_0.gguf`로 약 3.2GB 본문만 받습니다. 비전용 `mmproj` 파일은 받지 않습니다.
3. `model-dist/`에 `gemma-3-4b-it-q4_0.gguf.part00`, `.part01`, `SHA256SUMS`를 만듭니다.

조각 크기는 `PART_SIZE`로 바꿀 수 있습니다.

| 배포 방법 | 한도 | 권장 `PART_SIZE` |
|---|---|---|
| GitHub Release 첨부 | 파일당 2 GiB | `1900M` (기본) |
| Git LFS (무료) | 파일당 2 GB | `1900M` |
| LFS 없는 일반 git 커밋 | 파일당 100 MB | `95M` |

팀에 배포하려면 GitHub Release에 올리고, 받는 쪽은 `gh release download`로 받으면 됩니다.

```bash
gh release create model-v1 model-dist/* --repo <owner>/<repo> --title "Gemma 3 4B QAT Q4_0"
```

```bash
gh release download model-v1 --repo <owner>/<repo> -D model-dist
```

## 2. 기기로 옮기고 앱에서 풀기

**Android**
1. USB로 연결한 뒤 `model-dist/` 안의 파일을 전부 `Download/` 폴더로 복사합니다. `adb push model-dist/. /sdcard/Download/gemma/`로 보내도 됩니다.
2. 앱에서 **"모델 파일 선택"**을 누르고 `part00`, `part01`, `SHA256SUMS`를 **함께** 선택합니다.
3. 설치가 끝나면 원본 조각은 지워도 됩니다.

**iOS**
- 방법 A (권장, 저장 공간을 덜 씀): Mac Finder에서 iPhone → *파일* 탭 → **Gemma Chat**에 `model-dist/` 파일을 드래그합니다. 파일 앱 › *나의 iPhone* › *Gemma Chat*으로 복사해도 됩니다. 앱 화면의 **"이 파일들로 설치"**를 누르면 앱이 조각을 옮겨 붙이고, 끝나면 조각을 자동으로 지웁니다.
- 방법 B: **"모델 파일 선택"**에서 iCloud 등 다른 위치의 파일을 고릅니다. 이 경우 iOS가 임시 사본을 만들어 공간이 일시적으로 2배 더 필요합니다.

지원하는 입력 형식:

| 입력 | 처리 |
|---|---|
| `*.gguf` | 그대로 설치 |
| `*.gguf.part00`, `.part01` … (또는 `.001`, `.aa` 등) | 이름의 숫자 순서대로 이어 붙임 |
| `*.zip`, 그리고 `split`으로 나눈 zip 조각 | 이어 붙인 뒤 압축 해제 (zip64 지원) |
| `SHA256SUMS`, `*.sha256` | 같이 고르면 최종 .gguf를 검증 |

> Q4_0 가중치는 압축 효과가 거의 없으므로 zip 없이 분할만 하는 쪽이 빠르고 공간도 덜 씁니다.

## 3. 앱 빌드

네이티브 폴더(`android/`, `ios/`)는 Expo CNG가 생성하므로 저장소에 넣지 않습니다. llama.rn 네이티브 모듈이 있어서 Expo Go로는 실행할 수 없고, 개발 빌드나 릴리스 빌드가 필요합니다.

```bash
npm install
```

### Android
요구 사항: Android Studio(SDK, NDK), JDK 17 이상, arm64 기기(RAM 6GB 이상 권장)

릴리스 빌드에서는 INTERNET 권한이 제거되어 완전 오프라인으로 동작합니다.

```bash
npm run android:release
```

개발 빌드는 Metro에 연결해야 하므로 INTERNET 권한을 유지합니다.

```bash
npm run android
```

APK만 만들려면 `npx expo prebuild -p android`를 실행한 뒤 `cd android && ./gradlew assembleRelease`를 실행합니다.

### iOS
요구 사항: macOS, 최신 Xcode, iPhone(iOS 16.4 이상, RAM 6GB 이상 권장: iPhone 13 Pro, 15, 16 등)

```bash
npm run ios:release
```

- `NODE_ENV=production`일 때 llama.rn 플러그인이 `increased-memory-limit`, `extended-virtual-addressing` 엔타이틀먼트를 추가합니다. **유료 Apple Developer 계정**의 App ID에 해당 capability가 켜져 있어야 합니다. 4B 모델은 이 엔타이틀먼트가 없으면 메모리 한도에 걸려 종료될 수 있습니다.
- 서명할 Team은 Xcode에서 지정합니다(`ios/*.xcworkspace`).

### iOS — Windows + 무료 Apple ID (Mac 없이)

Mac이 없으면 GitHub Actions의 macOS 서버가 **서명 없는 .ipa**를 빌드하고, Windows의 [Sideloadly](https://sideloadly.io)가 무료 Apple ID로 서명해서 설치합니다.

1. **빌드:** `main`에 앱 코드를 push하면 자동으로 빌드됩니다. 저장소 *Actions › iOS unsigned IPA › Run workflow*로 직접 실행할 수도 있습니다. 25~40분 걸립니다.
2. **다운로드:** 실행 페이지 하단 *Artifacts*에서 `GemmaChat-unsigned-ipa`를 받아 압축을 풀면 `GemmaChat-unsigned.ipa`가 나옵니다.
3. **Windows 준비:** Apple 웹사이트에서 받은 **iTunes**와 **iCloud**를 설치합니다(Microsoft Store 버전 말고 apple.com 버전 권장). 그다음 Sideloadly를 설치합니다.
4. **설치:** iPhone을 USB로 연결하고 "이 컴퓨터 신뢰"를 누릅니다. Sideloadly에 .ipa를 끌어다 놓고, Apple ID를 입력한 뒤 *Start*를 누릅니다.
5. **iPhone 설정:**
   - *설정 › 개인정보 보호 및 보안 › 개발자 모드*를 켜고 재시동합니다.
   - *설정 › 일반 › VPN 및 기기 관리*에서 내 Apple ID 개발자를 *신뢰*합니다.
6. **모델 넣기:** Windows의 **Apple Devices** 앱(또는 iTunes)에서 iPhone › *파일* › **Gemma Chat**에 `model-dist/`의 조각과 `SHA256SUMS`를 끌어다 놓습니다. 앱에서 *이 파일들로 설치*를 누릅니다.

무료 Apple ID의 제약:
- 설치한 앱은 **7일 후 만료**됩니다. Sideloadly로 다시 설치하면 되고, 앱 데이터(설치한 모델)는 유지됩니다.
- `increased-memory-limit` 엔타이틀먼트를 쓸 수 없어 iOS가 앱에 주는 메모리가 작습니다. **RAM 8GB 기종**(iPhone 15 Pro 이상, 16 시리즈 이상)을 권장하고, 6GB 기종은 로딩 중 종료될 수 있습니다. 종료되면 설정에서 컨텍스트 길이를 2048로 줄이거나 GPU를 꺼 보세요.

### EAS (클라우드 빌드)

```bash
npx eas-cli@latest build -p android --profile production
```

## 4. 오프라인 동작 확인

- Android: 릴리스 APK를 설치한 뒤 *설정 › 앱 › Gemma Chat › 권한*에 네트워크 권한이 없는지 확인합니다. 비행기 모드에서도 똑같이 동작해야 합니다.
- `npx expo prebuild -p android`를 실행한 뒤 `android/app/src/main/AndroidManifest.xml`에 다음 줄이 있는지 확인합니다.
  `<uses-permission android:name="android.permission.INTERNET" tools:node="remove"/>`
- iOS에는 네트워크 "권한"이라는 개념이 없지만, 앱 코드에 네트워크 호출이 없고 비행기 모드에서 정상 동작합니다.

## 5. 구조

```
App.tsx                 화면 상태 전환 (모델 검색 → 설치 → 로딩 → 채팅)
src/modelStore.ts       조각 이어 붙이기 / 압축 해제 / SHA-256 검증 / 설치 모델 탐색
src/llm.ts              llama.rn 래퍼: 로드, Gemma 채팅 템플릿(jinja), 스트리밍, 컨텍스트 길이 맞추기
src/ChatScreen.tsx      채팅 UI, 생성 중지, 설정(시스템 프롬프트, n_ctx, 토큰 수, temperature, GPU)
src/SetupScreen.tsx     모델 가져오기 UI와 진행률
src/storage.ts          설정과 대화를 기기 안 JSON 파일로 저장
tools/pack_model.sh     PC: HF git 저장소에서 받아 분할
tools/split_model.py    PC: 분할 + SHA256SUMS
app.config.ts           INTERNET 권한 제거, 파일 공유(iOS), llama.rn 플러그인
```

## 6. 기본 생성 설정 (Gemma 3 권장값)

`temperature 1.0`, `top_k 64`, `top_p 0.95`, `min_p 0.0`, `n_ctx 4096`, 최대 생성 토큰 1024, 정지 토큰 `<end_of_turn>`

컨텍스트를 넘기면 오래된 대화부터 잘라냅니다. 토큰 수는 실제 토크나이저로 계산합니다.

## 7. 문제 해결

| 증상 | 조치 |
|---|---|
| "GGUF/ZIP 헤더로 시작하지 않음" | `part00`이 빠졌거나, git-lfs 포인터 파일(약 130바이트)만 받은 경우입니다. `git lfs pull`을 다시 실행하세요. |
| "SHA-256 불일치" | 조각 일부가 손상됐거나 빠졌습니다. 다시 복사하세요. |
| 로딩 중 앱 종료 | RAM 부족입니다. 설정에서 n_ctx를 2048로 줄이고, iOS는 엔타이틀먼트를 확인하세요. |
| Android에서 느림 | Snapdragon 8 Gen 2 이상(Adreno 7xx)이면 설정에서 GPU 가속을 켜 보세요. |

## 라이선스

- 앱 코드: 원하는 라이선스로 지정하세요.
- 모델: [Gemma Terms of Use](https://ai.google.dev/gemma/terms)를 따릅니다. 모델 파일을 재배포하려면 약관을 확인하세요.

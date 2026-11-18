/**
 * 기기 안 OCR (인터넷 없음).
 * - iOS: Apple Vision (VNRecognizeTextRequest, 한국어+영어, 정확도 우선). 앱 크기 증가 없음.
 * - Android: Google ML Kit 한국어 인식 모델(앱에 포함, bundled). 한글+영문 함께 인식.
 *
 * 네이티브 모듈이 없는 예전 앱(OTA 로 이 JS 만 받은 경우)에서는 isOcrAvailable() 가 false 다.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type OcrLine = {
  text: string;
  /** 0~1 (플랫폼이 주지 않으면 -1) */
  confidence: number;
  /** 이미지 크기 기준 0~1, 왼쪽 위 원점 */
  box: { x: number; y: number; width: number; height: number };
};

export type OcrResult = {
  /** 읽은 글자 전체 (위→아래 순서, 줄바꿈으로 구분) */
  text: string;
  lines: OcrLine[];
};

type NativeOcr = { recognizeText(uri: string): Promise<OcrResult> };

const native = requireOptionalNativeModule<NativeOcr>('ExpoOcr');

export const isOcrAvailable = () => native != null;

/** file:// 이미지에서 글자를 읽는다 */
export async function recognizeText(uri: string): Promise<OcrResult> {
  if (!native) throw new Error('이 앱 버전에는 OCR 기능이 없습니다. 최신 버전을 설치하세요.');
  const r = await native.recognizeText(uri);
  return { text: (r?.text ?? '').trim(), lines: r?.lines ?? [] };
}

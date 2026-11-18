/**
 * 사진 위에 표시할 정보 만들기 (모두 기기 안에서).
 *  - 글자: 기기 OCR 이 준 줄별 위치(box)와 글자. 외국어 줄은 나중에 Gemma 가 한국어로 번역해 그 자리에 덮어 보여 준다.
 *  - 물건: 기기 물체 인식(MediaPipe EfficientDet-Lite0, 일상 물건 80종)이 준 위치와 이름 → 한국어 이름.
 * 물체 인식 모듈이 없는 예전 앱 빌드에서는 글자만 표시한다.
 */
import { detectObjects, isObjectDetectionAvailable, isOcrAvailable, recognizeText, type Box } from '../modules/expo-ocr';

export type AnnotLine = { text: string; box: Box };
export type AnnotObject = { label: string; score: number; box: Box };
export type PhotoAnnotations = {
  lines: AnnotLine[];
  objects: AnnotObject[];
  /** lines 와 같은 순서. null = 번역할 필요 없는 줄(한국어 등) */
  translations?: (string | null)[];
};

export type PhotoAnalysis = { text: string | null; annot: PhotoAnnotations | null };

/** OCR + 물체 인식을 함께 돌린다. 실패한 쪽은 비워 둔다 */
export async function analyzePhoto(uri: string): Promise<PhotoAnalysis> {
  const [ocr, objs] = await Promise.all([
    isOcrAvailable() ? recognizeText(uri).catch(() => null) : Promise.resolve(null),
    isObjectDetectionAvailable() ? detectObjects(uri).catch(() => []) : Promise.resolve([]),
  ]);
  const lines = (ocr?.lines ?? []).filter((l) => l.text.trim()).map((l) => ({ text: l.text.trim(), box: l.box }));
  const objects = objs.map((o) => ({ label: koreanLabel(o.label), score: o.score, box: o.box }));
  return {
    text: ocr ? ocr.text : null,
    annot: lines.length || objects.length ? { lines, objects } : null,
  };
}

/** 번역이 필요한 줄인지 (글자 2자 이상, 한글이 절반 미만) */
export function needsTranslation(line: string): boolean {
  // 한글이 없고, 외국 글자(라틴·가나·한자·키릴·태국)가 2자 이상인 줄
  return !/[가-힣]/.test(line) && /[A-Za-z\u00c0-\u024f\u3040-\u30ff\u4e00-\u9fff\u0400-\u04ff\u0e00-\u0e7f]{2,}/.test(line);
}

// ───────────────────────── COCO 80종 → 한국어

const KO: Record<string, string> = {
  person: '사람', bicycle: '자전거', car: '자동차', motorcycle: '오토바이', airplane: '비행기', bus: '버스', train: '기차',
  truck: '트럭', boat: '배', 'traffic light': '신호등', 'fire hydrant': '소화전', 'stop sign': '정지 표지판',
  'parking meter': '주차 미터기', bench: '벤치', bird: '새', cat: '고양이', dog: '개', horse: '말', sheep: '양', cow: '소',
  elephant: '코끼리', bear: '곰', zebra: '얼룩말', giraffe: '기린', backpack: '배낭', umbrella: '우산', handbag: '핸드백',
  tie: '넥타이', suitcase: '여행 가방', frisbee: '프리스비', skis: '스키', snowboard: '스노보드', 'sports ball': '공',
  kite: '연', 'baseball bat': '야구 방망이', 'baseball glove': '야구 글러브', skateboard: '스케이트보드', surfboard: '서핑보드',
  'tennis racket': '테니스 라켓', bottle: '병', 'wine glass': '와인잔', cup: '컵', fork: '포크', knife: '칼', spoon: '숟가락',
  bowl: '그릇', banana: '바나나', apple: '사과', sandwich: '샌드위치', orange: '오렌지', broccoli: '브로콜리', carrot: '당근',
  'hot dog': '핫도그', pizza: '피자', donut: '도넛', cake: '케이크', chair: '의자', couch: '소파', 'potted plant': '화분',
  bed: '침대', 'dining table': '식탁', toilet: '변기', tv: 'TV', laptop: '노트북', mouse: '마우스', remote: '리모컨',
  keyboard: '키보드', 'cell phone': '휴대폰', microwave: '전자레인지', oven: '오븐', toaster: '토스터', sink: '싱크대',
  refrigerator: '냉장고', book: '책', clock: '시계', vase: '꽃병', scissors: '가위', 'teddy bear': '곰 인형',
  'hair drier': '헤어드라이어', toothbrush: '칫솔',
};

export function koreanLabel(label: string): string {
  return KO[label.toLowerCase()] ?? label;
}

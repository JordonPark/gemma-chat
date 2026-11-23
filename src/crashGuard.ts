/**
 * 앱이 "툭" 꺼졌는지 알아채기.
 * 메모리를 많이 쓰는 작업(모델·이미지 인식 올리기, 답 만들기, 사진 분석) 직전에 단계를 파일에 적어 두고, 끝나면 지운다.
 * 다음에 앱을 켰을 때 남아 있는 단계는 작업이 끝나기 전에 앱이 종료됐다는 뜻이다.
 */
import { File, Paths } from 'expo-file-system';

export type Stage = 'load-model' | 'load-vision' | 'generate' | 'photo' | 'generate-photo';

const stateFile = () => new File(Paths.document, '.session-stage.json');
const active = new Map<symbol, Stage>();

function persistStage(stage?: Stage) {
  try {
    const f = stateFile();
    if (!stage) {
      if (f.exists) f.delete();
      return;
    }
    if (!f.exists) f.create();
    f.writeSync(JSON.stringify({ stage, at: Date.now() }));
  } catch {}
}

export function markStage(stage: Stage): () => void {
  const id = Symbol(stage);
  active.set(id, stage);
  persistStage(stage);
  return () => {
    if (active.delete(id)) persistStage(Array.from(active.values()).at(-1));
  };
}

/** 지난 실행이 작업 도중 꺼졌으면 그 단계를 돌려주고 기록을 지운다 */
export function takeLastCrash(): Stage | null {
  try {
    const f = stateFile();
    if (!f.exists) return null;
    const v = JSON.parse(f.textSync()) as { stage?: Stage; at?: number };
    f.delete();
    // 아주 오래된 기록(하루 넘음)은 무시
    if (!v?.stage || !v.at || Date.now() - v.at > 24 * 3600_000) return null;
    return v.stage;
  } catch {
    return null;
  }
}

export function describeStage(stage: Stage): string {
  switch (stage) {
    case 'load-model':
      return '채팅 모델을 불러오는';
    case 'load-vision':
      return '이미지 인식을 준비하는';
    case 'generate':
      return '답변을 만드는';
    case 'photo':
      return '사진을 분석하는';
    case 'generate-photo':
      return '사진으로 답변을 만드는';
  }
}

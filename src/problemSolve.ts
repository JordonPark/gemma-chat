/**
 * 사진 속 문제 풀이 모드.
 * 사진과 함께 "풀어줘·정답·해설·구해" 같은 말을 보내면, 문제를 먼저 옮겨 적고 단계별로 푼 뒤 "정답:"으로 끝내게 한다.
 * 풀이 속 계산식("12×13 = 158")은 기기 계산기로 다시 확인해, 틀린 곳이 있으면 답 아래에 알려 준다.
 */
import { calculate, formatNumber } from './tools';

const SOLVE_INTENT =
  /(풀어|풀이|풀래|정답|답\s*(이|은|좀|알려|뭐|구해)|해설|문제|채점|계산해|구해|증명|맞는\s*(답|것)|몇\s*번|solve|answer)/i;

/** 사진 + 문제 풀이 요청인지 */
export function isSolveRequest(text: string, hasPhoto: boolean): boolean {
  return hasPhoto && SOLVE_INTENT.test(text);
}

/** 문제 풀이 때 시스템 프롬프트에 더하는 지침 */
export const SOLVE_GUIDE = [
  'The user sent a photo of a problem (math, science, exam question, worksheet, etc.) and wants it solved.',
  '1) Start with "문제:" and rewrite the problem accurately in Korean script as it appears (keep the original language for English/foreign questions). The OCR text attached to the message is more reliable for words and numbers than reading the image; use the image for formulas, diagrams, tables and choices.',
  '2) Solve step by step with short numbered steps. Write calculations as plain expressions like "12 × 13 = 156".',
  '3) Check every calculation and the final result before answering.',
  '4) Finish with one line: "**정답:** ..." (for multiple choice, give the option number and its content).',
  'If part of the problem is unreadable or cut off, say exactly which part and ask for a clearer photo instead of guessing.',
].join('\n');

/** 사진 답의 첫머리 (문제 풀이용) */
export const SOLVE_HEADER = '**분석되었습니다.** 사진 속 문제를 풀었어요.';

/**
 * 풀이 속 "식 = 값" 을 계산기로 다시 계산해 본다. 틀린 것만 돌려준다.
 * 분수·근호 같은 기호는 건너뛴다 (계산기가 읽을 수 있는 식만 확인).
 */
export function checkArithmetic(solution: string): { expr: string; claimed: string; actual: string }[] {
  const wrong: { expr: string; claimed: string; actual: string }[] = [];
  // 한 줄 안에서만 찾는다 (공백은 스페이스·탭만)
  const re = /([0-9(][0-9 \t+\-*/×÷^().,%]*[+\-*/×÷^][0-9 \t+\-*/×÷^().,%]*?)[ \t]*=[ \t]*(-?[0-9][0-9,]*(?:\.[0-9]+)?)(?![0-9.])/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  // 줄마다 앞의 목록 번호("1.", "2)", "- ")를 떼고 본다 (번호를 소수점으로 읽지 않게)
  const text = solution
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]\s+|\(?\d{1,2}[.)]\s+|단계\s*\d+\s*[:.)]\s*)/, ''))
    .join('\n');
  while ((m = re.exec(text)) && wrong.length < 3) {
    const expr = m[1].trim();
    const claimedRaw = m[2];
    if (seen.has(expr) || !/\d\s*[+\-*/×÷^]\s*[\d(]/.test(expr)) continue;
    seen.add(expr);
    let actual: number;
    try {
      actual = calculate(expr);
    } catch {
      continue;
    }
    const claimed = Number(claimedRaw.replace(/,/g, ''));
    if (!Number.isFinite(claimed)) continue;
    const tol = Math.max(1e-6, Math.abs(actual) * 1e-4) + (claimedRaw.includes('.') ? 0.5 * 10 ** -(claimedRaw.split('.')[1].length) : 0);
    if (Math.abs(actual - claimed) > tol) wrong.push({ expr, claimed: claimedRaw, actual: formatNumber(actual) });
  }
  return wrong;
}

/** 계산이 틀린 곳이 있으면 답 아래에 붙일 안내 */
export function arithmeticNote(solution: string): string {
  const wrong = checkArithmetic(solution);
  if (!wrong.length) return '';
  return (
    '\n\n> 🧮 **계산 확인:** 풀이의 계산 중 기기 계산기 결과와 다른 곳이 있어요. 정답도 다시 확인해 주세요.\n' +
    wrong.map((w) => `> - ${w.expr} = **${w.actual}** (풀이에는 ${w.claimed})`).join('\n')
  );
}

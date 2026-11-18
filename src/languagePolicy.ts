/**
 * 언어 가드레일: 한국 사용자를 위한 앱이므로 답은 되도록 한국어로 한다.
 * 번역·통역·외국어 작문/학습처럼 다른 언어가 필요한 요청일 때만 그 부분을 해당 언어로 쓰고, 설명은 한국어로 한다.
 * 코드, 고유명사, 원문 인용은 그대로 둔다.
 *
 * 1) LANGUAGE_GUIDE: 시스템 프롬프트에 넣는 규칙
 * 2) needsKoreanRetry: 답이 대부분 외국어인데 번역류 요청이 아니면 한국어로 한 번 다시 만들게 한다
 */

export const LANGUAGE_GUIDE = [
  'Language rules (the users are Korean):',
  '- Always answer in Korean (한국어) by default, even if the question contains English words.',
  '- Use another language only for the part that needs it: translations, interpretation, writing an email/sentence in a foreign language, language-learning examples, or when the user explicitly asks for another language. Keep the surrounding explanation in Korean.',
  '- Code, commands, proper nouns, product names and quoted original text may stay as they are.',
].join('\n');

/** 마지막에 다시 확인하는 짧은 문구 */
export const LANGUAGE_REMINDER = 'Answer in Korean unless the request is about translation or another language.';

/** 번역·외국어가 필요한 요청인지 */
const LANGS = '영어|일본어|일어|중국어|중문|스페인어|프랑스어|불어|독일어|베트남어|태국어|러시아어|이탈리아어|포르투갈어|아랍어|인도네시아어|몽골어|힌디어';
const FOREIGN_INTENT = new RegExp(
  `(번역|통역|영작|[가-힣]{1,5}어로|(${LANGS})\\s*(로|표현|문장|단어|회화|공부|발음|문법|버전|이메일|메일|편지|자기소개|작문|가사|뜻|글|답장|인사)|영문|외국어|원어|뭐라고\\s*(해|말해|하나|하지|써)|어떻게\\s*말해|발음|회화|translate|translation|in\\s+(english|japanese|chinese|spanish|french|german|vietnamese|thai|russian)|english|日本語|中文)`,
  'i',
);

export function wantsForeignLanguage(request: string): boolean {
  return FOREIGN_INTENT.test(request);
}

/** 코드 블록·인라인 코드·URL 을 뺀 본문 */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
}

const HANGUL = /[가-힣ㄱ-ㆎ]/g;
// 라틴(악센트 포함)·가나·한자·키릴·태국 문자
const FOREIGN = /[A-Za-zÀ-ɏḀ-ỿ぀-ヿ一-鿿Ѐ-ӿ฀-๿]/g;

/** 본문 글자 중 한글 비율 (0~1). 글자가 거의 없으면 1 */
export function koreanRatio(text: string): number {
  const p = prose(text);
  const ko = p.match(HANGUL)?.length ?? 0;
  const other = p.match(FOREIGN)?.length ?? 0;
  if (ko + other < 20) return 1;
  return ko / (ko + other);
}

/**
 * 답을 한국어로 다시 만들어야 하는지.
 * 번역류 요청이 아닌데 본문의 절반 넘게 외국어면 true. (사진 속 글자를 다루는 질문은 원문 인용이 많아 제외)
 */
export function needsKoreanRetry(reply: string, request: string, hasPhoto = false): boolean {
  if (hasPhoto || wantsForeignLanguage(request)) return false;
  return koreanRatio(reply) < 0.5;
}

export const SAFETY_GUIDE = [
  'Do not generate content that sexualizes or exploits children, explicit sexual images, nonconsensual intimate images, or graphic abuse.',
  'Refuse actionable assistance for serious violence, suicide or self-harm, hateful or targeted harassment, fraud, impersonation, dangerous illegal instructions, malware, or disclosure of private identifying data.',
  'Do not portray a real person in a sexual or deceptively harmful situation. Allow factual discussion, prevention, and safety-seeking requests.',
].join(' ');

export class ContentSafetyError extends Error {}

export const SAFETY_REFUSAL = '이 요청이나 결과는 앱의 콘텐츠 이용 기준에 따라 표시할 수 없습니다. 다른 방식으로 물어봐 주세요.';

export const SAFETY_SCHEMA = {
  type: 'object',
  properties: { allowed: { type: 'boolean' } },
  required: ['allowed'],
  additionalProperties: false,
};

export function safetyPasses(raw: string): boolean {
  try {
    return JSON.parse(raw.trim())?.allowed === true;
  } catch {
    return false;
  }
}

export function safetySegments(text: string): string[] {
  const chars = Array.from(text.trim());
  const segments: string[] = [];
  for (let offset = 0; offset < chars.length; offset += 720) {
    segments.push(chars.slice(offset, offset + 900).join(''));
    if (offset + 900 >= chars.length) break;
  }
  return segments;
}

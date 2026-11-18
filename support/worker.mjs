import legal from '../src/legalDocuments.json' with { type: 'json' };
import licenses from '../licenses/modelLicenses.json' with { type: 'json' };

const REPORT_REASONS = new Set(['sexual', 'violence', 'abuse', 'deception', 'other']);
const CONTENT_TYPES = new Set(['text/plain', 'image/jpeg;base64', 'image/svg+xml']);
const MAX_REQUEST_BYTES = 1_100_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const utf8 = new TextDecoder();
const utf8Encoder = new TextEncoder();
const isText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const json = (status, body) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:3rem auto;padding:0 1rem;max-width:48rem;color:#241b33}
pre{white-space:pre-wrap;font:inherit;overflow-wrap:anywhere}label{display:block;margin:1rem 0}
input,textarea,button{font:inherit;padding:.55rem;max-width:100%;box-sizing:border-box}textarea,input{width:100%}</style>
<main><h1>${escapeHtml(title)}</h1>${body}</main></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function readBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit || !request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return utf8.decode(bytes);
}

async function record(env, fields) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO inbox (id, submitted_at, kind, email, reason, platform, app_version, content_type, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    id, Date.now(), fields.kind, fields.email ?? null, fields.reason ?? null, fields.platform ?? null,
    fields.appVersion ?? null, fields.type, fields.content,
  ).run();
  return id;
}

function validateReport(report) {
  if (!report || !REPORT_REASONS.has(report.reason) || !CONTENT_TYPES.has(report.type)
      || !['ios', 'android'].includes(report.platform) || !isText(report.appVersion, 32)) return false;
  if (report.type === 'image/jpeg;base64') {
    return isText(report.content, 1_048_576)
      && report.content.startsWith('/9j/') && /^[A-Za-z0-9+/]+={0,2}$/.test(report.content);
  }
  return isText(report.content, report.type === 'image/svg+xml' ? 32_000 : 24_000);
}

const supportForm = `<p>개인정보 문의나 삭제 요청을 비공개로 보낼 수 있습니다. 접수번호가 있다면 문의에 적어 주세요.</p>
<form method="post" action="/support">
<label>회신 이메일 <input type="email" name="email" autocomplete="email" required maxlength="254"></label>
<label>문의 내용 <textarea name="message" rows="6" required maxlength="2000"></textarea></label>
<p><a href="/privacy">개인정보처리방침</a></p>
<button type="submit">문의 보내기</button></form>`;

const downloads = new Map([
  ['/licenses/gemma-terms.txt', licenses.gemmaTerms],
  ['/licenses/gemma-prohibited-use.txt', licenses.gemmaProhibitedUse],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      if (url.pathname === '/privacy') return page('개인정보처리방침',
        `<pre>${escapeHtml(legal.privacy)}</pre><p><a href="/support">개인정보 문의 및 삭제 요청</a></p>`);
      if (url.pathname === '/terms') return page('앱 이용약관',
        `<pre>${escapeHtml(legal.terms)}</pre><ul>
<li><a href="/licenses/gemma-terms.txt">Gemma 라이선스</a></li>
<li><a href="/licenses/gemma-prohibited-use.txt">Gemma 금지 사용 정책</a></li></ul>`);
      if (url.pathname === '/support') return page('개인정보 문의', supportForm);
      if (downloads.has(url.pathname)) return new Response(downloads.get(url.pathname), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
      });
    }

    const isSupport = url.pathname === '/support';
    if (request.method !== 'POST' || (!isSupport && url.pathname !== '/reports')) return json(404, { error: 'not_found' });
    const replyError = (status, message) => isSupport
      ? page('문의 접수 오류', `<p>${escapeHtml(message)}</p><p><a href="/support">문의로 돌아가기</a></p>`, status)
      : json(status, { error: message });

    try {
      const key = request.headers.get('CF-Connecting-IP') || 'unidentified';
      if (!(await env.SUBMISSIONS.limit({ key })).success) return replyError(429, '잠시 후 다시 시도해 주세요.');
      const body = await readBody(request, isSupport ? 24_000 : MAX_REQUEST_BYTES);
      if (body === null) return replyError(413, '전송할 내용이 너무 큽니다.');
      if (isSupport) {
        const form = new URLSearchParams(body);
        const email = form.get('email')?.trim();
        const content = form.get('message')?.trim();
        if (!isText(email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !isText(content, 2000)) {
          return replyError(400, '이메일과 문의 내용을 확인해 주세요.');
        }
        const id = await record(env, { kind: 'support', email, content, type: 'text/plain' });
        return page('문의가 접수됐습니다', `<p>접수번호 <code>${id}</code></p>`, 201);
      }

      let report;
      try { report = JSON.parse(body); } catch { return replyError(400, '신고 내용을 확인해 주세요.'); }
      if (!validateReport(report)) return replyError(400, '신고 내용을 확인해 주세요.');
      if (utf8Encoder.encode(report.content).byteLength > MAX_REQUEST_BYTES) return replyError(413, '전송할 내용이 너무 큽니다.');
      const id = await record(env, { ...report, kind: 'report', email: null });
      return json(201, { id });
    } catch {
      return replyError(503, '지금 접수할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    }
  },
  async scheduled(_controller, env) {
    await env.DB.prepare('DELETE FROM inbox WHERE submitted_at < ?').bind(Date.now() - RETENTION_MS).run();
  },
};

/**
 * 진행 이벤트에 기대지 않는 다운로드.
 *
 * iOS 일부 환경에서 네이티브 다운로드의 진행(progress) 이벤트가 JS 로 오지 않아 0% 에서 멈춘 것처럼 보였다.
 * 그래서 파일을 32MB 씩 HTTP Range 요청으로 나눠 받고, 조각 하나가 끝날 때마다 대상 파일 끝에 붙인다.
 *
 * - 진행률: 조각이 끝날 때마다 확실히 올라간다 (이벤트가 오면 조각 안에서도 더 촘촘히 움직인다).
 * - 이어받기: 대상 파일 크기 = 받은 양. 앱이 꺼져도 그 지점부터 다시 받는다.
 * - 멈춤 대비: 조각 하나가 2분 안에 안 끝나면 끊고 다시 요청한다 (조각마다 최대 5번).
 * - GitHub Release 는 Range 를 지원한다(206). 서버가 Range 를 무시하면 크기가 달라 바로 알아챈다.
 */
import { File, FileMode } from 'expo-file-system';

export const CHUNK_BYTES = 32 * 1024 * 1024;
const CHUNK_TIMEOUT_MS = 120_000;
const CHUNK_ATTEMPTS = 5;
const COPY_BUF = 8 * 1024 * 1024;

export class RangedCancelled extends Error {
  constructor() {
    super('다운로드를 취소했습니다.');
  }
}

export type Source = { url: string; size: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GitHub Release 주소는 실제 저장소(서명된 임시 주소)로 리다이렉트된다.
 * 리다이렉트 때 Range 헤더가 빠지면 조각 대신 파일 전체가 오므로, 최종 주소를 먼저 알아내 거기에 직접 요청한다.
 * (서명된 주소는 몇 분 뒤 만료되므로 60초마다 새로 받는다)
 */
const resolved = new Map<string, { url: string; at: number }>();
async function finalUrl(url: string, signal: AbortSignal): Promise<string> {
  const c = resolved.get(url);
  if (c && Date.now() - c.at < 60_000) return c.url;
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
    const u = res.url && res.ok ? res.url : url;
    resolved.set(url, { url: u, at: Date.now() });
    return u;
  } catch (e) {
    if (signal.aborted) throw new RangedCancelled();
    return url; // 확인에 실패하면 원래 주소로 시도
  }
}

async function appendTo(src: File, dest: File) {
  if (!dest.exists) dest.create({ intermediates: true });
  const out = dest.open(FileMode.Append);
  const inp = src.open(FileMode.ReadOnly);
  try {
    for (;;) {
      const b = await inp.readBytes(COPY_BUF);
      if (b.length === 0) break;
      await out.writeBytes(b);
    }
  } finally {
    inp.close();
    out.close();
  }
}

/** 조각 하나를 받는다 (시간 제한 + 바깥 취소 연동) */
async function fetchRange(
  url: string,
  start: number,
  end: number,
  tmp: File,
  signal: AbortSignal,
  onBytes: (n: number) => void,
) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener('abort', onAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, CHUNK_TIMEOUT_MS);
  try {
    if (tmp.exists) tmp.delete();
    await File.downloadFileAsync(url, tmp, {
      headers: { Range: `bytes=${start}-${end}` },
      idempotent: true,
      signal: ac.signal,
      onProgress: ({ bytesWritten }) => onBytes(bytesWritten),
    });
  } catch (e: any) {
    if (signal.aborted) throw new RangedCancelled();
    if (timedOut) throw new Error('응답이 너무 느립니다(2분 초과)');
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  const want = end - start + 1;
  const got = tmp.size ?? 0;
  if (got !== want) {
    if (tmp.exists) tmp.delete();
    throw new Error(got > want ? '서버가 부분 다운로드(Range)를 지원하지 않습니다' : `조각 크기가 다릅니다 (${got}/${want})`);
  }
}

/**
 * sources 를 순서대로 이어 받은 결과를 dest 에 만든다. dest 가 이미 있으면 그 크기만큼은 받은 것으로 보고 이어 받는다.
 * onProgress(받은 바이트, 전체 바이트)
 */
export async function downloadRanged(
  sources: Source[],
  dest: File,
  tmp: File,
  onProgress: (done: number, total: number, note?: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const total = sources.reduce((s, x) => s + x.size, 0);
  let done = dest.exists ? dest.size ?? 0 : 0;
  if (done > total) {
    dest.delete();
    done = 0;
  }
  onProgress(done, total);

  let srcStart = 0;
  for (const src of sources) {
    const srcEnd = srcStart + src.size; // 이 소스가 전체에서 차지하는 [srcStart, srcEnd)
    while (done < srcEnd) {
      if (signal.aborted) throw new RangedCancelled();
      const from = done - srcStart;
      const to = Math.min(from + CHUNK_BYTES, src.size) - 1;
      for (let attempt = 1; ; attempt++) {
        try {
          const url = await finalUrl(src.url, signal);
          await fetchRange(url, from, to, tmp, signal, (n) => onProgress(done + n, total));
          break;
        } catch (e: any) {
          if (e instanceof RangedCancelled || signal.aborted) throw new RangedCancelled();
          resolved.delete(src.url); // 주소가 만료됐을 수 있으니 다음 시도 때 새로 받는다
          if (attempt >= CHUNK_ATTEMPTS) throw new Error(`${e?.message ?? e} (${CHUNK_ATTEMPTS}번 시도)`);
          onProgress(done, total, `다시 시도 중 (${attempt}/${CHUNK_ATTEMPTS - 1})`);
          await sleep(2000 * attempt);
        }
      }
      await appendTo(tmp, dest);
      tmp.delete();
      done += to - from + 1;
      if (dest.size !== done) throw new Error('저장 중 파일 크기가 어긋났습니다. 다시 시도하세요.');
      onProgress(done, total);
    }
    srcStart = srcEnd;
  }
}

/**
 * Optional provider-neutral second resolver.
 * POST {"url":"https://source.example/watch/..."} to MEDIA_FALLBACK_API_URL;
 * expect {"stream_url":"https://public-cdn.example/audio?..."} ("url" alias).
 * This is NOT a scraper for any particular website and cannot remove DRM.
 * The provider must be authorized to return playable, public HTTPS media.
 */
import { validatePublicHttpsUrl } from './media-url.js';

const MAX_RESPONSE_BYTES = 16384;

export function fallbackConfigured(env = process.env) {
  return Boolean(env.MEDIA_FALLBACK_API_URL?.trim());
}

function fallbackError(message) {
  // Never include raw provider response, a signed media URL, or an API key.
  return Error(`Nguồn trung gian: ${message}`);
}

async function readSmallJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw fallbackError('phản hồi quá lớn.');
  const reader = response.body?.getReader();
  if (!reader) throw fallbackError('phản hồi rỗng.');
  let bytes = 0;
  const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw fallbackError('phản hồi quá lớn.');
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = Buffer.concat(parts.map(x => Buffer.from(x)), bytes);
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw fallbackError('API không trả về JSON hợp lệ.'); }
}

/** Always revalidate any URL returned by an external party. */
export async function resolveFallbackMedia(raw, {
  env = process.env,
  fetchFn = fetch,
  lookup,
} = {}) {
  if (!fallbackConfigured(env)) throw fallbackError('chưa cấu hình MEDIA_FALLBACK_API_URL.');
  if (typeof env.MEDIA_FALLBACK_API_KEY === 'string' && /[\r\n]/.test(env.MEDIA_FALLBACK_API_KEY)) {
    throw fallbackError('API key có ký tự không hợp lệ.');
  }
  // Validate the provider itself and the original request (no internal hosts).
  const provider = await validatePublicHttpsUrl(env.MEDIA_FALLBACK_API_URL.trim(), lookup);
  const sourceUrl = await validatePublicHttpsUrl(raw, lookup);
  const timeout = Math.max(3000, Math.min(30000, Number(env.MEDIA_FALLBACK_TIMEOUT_MS) || 12000));
  let response;
  try {
    response = await fetchFn(provider, {
      method: 'POST', redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(env.MEDIA_FALLBACK_API_KEY ? { Authorization: `Bearer ${env.MEDIA_FALLBACK_API_KEY}` } : {})
      },
      body: JSON.stringify({ url: sourceUrl }),
      signal: AbortSignal.timeout(timeout)
    });
  } catch {
    throw fallbackError('không kết nối được hoặc quá thời gian chờ.');
  }
  if (!response.ok) throw fallbackError(`API trả HTTP ${response.status}.`);
  const data = await readSmallJson(response);
  const streamUrl = data?.stream_url ?? data?.url;
  if (typeof streamUrl !== 'string') throw fallbackError('API thiếu trường stream_url.');
  try { return await validatePublicHttpsUrl(streamUrl, lookup); }
  catch { throw fallbackError('API trả về địa chỉ âm thanh không an toàn hoặc không hợp lệ.'); }
}

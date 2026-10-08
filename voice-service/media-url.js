/**
 * Public HTTPS media URL validation and yt-dlp source discovery.
 *
 * IMPORTANT: DNS validation cannot stop DNS rebinding, downloader redirects or
 * HLS subrequests. Run yt-dlp and ffmpeg under a network egress firewall that
 * rejects private/link-local addresses (see AWS_VOICE_SETUP.md).
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const badIP = new BlockList();
for (const [base, mask] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) badIP.addSubnet(base, mask, 'ipv4');

// Only globally-routable IPv6 unicast may be used (2000::/3), excluding
// documentation, relay/tunnel, and other special-purpose space.
const ipv6Global = new BlockList();
ipv6Global.addSubnet('2000::', 3, 'ipv6');
for (const [base, mask] of [
  ['2001::', 32], ['2001:10::', 28], ['2001:db8::', 32],
  ['2002::', 16]
]) badIP.addSubnet(base, mask, 'ipv6');

export function isPublicIP(ip) {
  const family = isIP(ip);
  if (family === 4) return !badIP.check(ip, 'ipv4');
  if (family === 6) return ipv6Global.check(ip, 'ipv6') && !badIP.check(ip, 'ipv6');
  return false;
}

/** Validate syntax and host before any network I/O. */
export function parsePublicHttpsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 900 || /[\r\n\x00-\x1F\x7F]/.test(value)) {
    throw Error('URL trống, quá dài hoặc chứa ký tự không hợp lệ.');
  }
  let url;
  try { url = new URL(value); } catch { throw Error('Link không hợp lệ.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw Error('Chỉ hỗ trợ HTTPS công khai (cổng 443), không chứa tài khoản/mật khẩu.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host.length > 253 || /^(localhost|metadata)(\.|$)/.test(host) ||
      /\.(localhost|local|internal|home|home\.arpa|test|invalid|example|onion|arpa)$/.test(host)) {
    throw Error('Không chấp nhận địa chỉ cục bộ hoặc nội bộ.');
  }
  if (isIP(host)) {
    if (!isPublicIP(host)) throw Error('Không chấp nhận địa chỉ IP riêng hoặc đặc biệt.');
  } else if (!host.includes('.') || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw Error('Hostname không hợp lệ.');
  }
  url.hash = '';
  return url.href;
}

/** Reject hosts that resolve to even one private/special-purpose address. */
export async function validatePublicHttpsUrl(value, lookup = dnsLookup) {
  const canonical = parsePublicHttpsUrl(value);
  const host = new URL(canonical).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!isIP(host)) {
    let results;
    try { results = await lookup(host, { all: true }); }
    catch { throw Error('Không phân giải được tên miền nguồn âm thanh.'); }
    if (!Array.isArray(results) || !results.length || results.some(({ address }) => !isPublicIP(address))) {
      throw Error('Nguồn âm thanh trỏ tới địa chỉ mạng riêng hoặc bị hạn chế.');
    }
  }
  return canonical;
}

const DIRECT_AUDIO = /\.(mp3|ogg|opus|m4a|aac|wav|flac|m3u8)$/i;
const PROXY_ENV_RE = /^(https?_proxy|all_proxy|no_proxy)$/i;

// A YouTube Radio/share URL may contain a playlist context that we do not need
// for one-song playback. Keep only the 11-character video ID.
function standaloneVideoUrl(validatedUrl) {
  const input = new URL(validatedUrl);
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(input.hostname.toLowerCase())) return validatedUrl;
  if (input.pathname !== '/watch') return validatedUrl;
  const id = input.searchParams.get('v');
  return id && /^[A-Za-z0-9_-]{11}$/.test(id)
    ? `https://www.youtube.com/watch?v=${id}` : validatedUrl;
}

function extractionFailure(err) {
  if (err.code === 'ENOENT') return Error('Chưa cài yt-dlp trên máy chủ.');
  const stderr = String(err.stderr || '').toLowerCase();
  if (/sign in to confirm|not a bot|this video is private|login required|members-only|age.restricted/.test(stderr)) {
    return Error('YouTube yêu cầu đăng nhập hoặc xác minh truy cập từ máy chủ AWS; link này hiện không thể phát công khai.');
  }
  if (/javascript runtime|challenge solver|yt.dlp.ejs|ejs scripts/.test(stderr)) {
    return Error('Thiếu JavaScript runtime hoặc bộ giải thử thách yt-dlp-ejs. Hãy cài yt-dlp[default] và kiểm tra Node.js.');
  }
  if (/requested format is not available|no video formats found/.test(stderr)) {
    return Error('yt-dlp không tìm thấy luồng âm thanh có thể phát từ nguồn này.');
  }
  if (err.killed || err.signal === 'SIGKILL') return Error('yt-dlp xử lý quá lâu và bị dừng (timeout).');
  return Error('yt-dlp không thể trích xuất link. Chạy yt-dlp trực tiếp trên EC2 để xem lỗi gốc (có thể do mạng, hạn chế YouTube hoặc nguồn không hỗ trợ).');
}

export async function resolveMediaInput(raw, { lookup = dnsLookup, run = execFileAsync } = {}) {
  const url = await validatePublicHttpsUrl(raw, lookup);
  if (DIRECT_AUDIO.test(new URL(url).pathname)) return url;
  const extractorUrl = await validatePublicHttpsUrl(standaloneVideoUrl(url), lookup);

  // Use site-specific extractors for popular public sites; refuse the generic
  // scraper, which otherwise accepts arbitrary websites, including intranet.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROXY_ENV_RE.test(key)));
  let stdout;
  try {
    ({ stdout } = await run('yt-dlp', [
      '--ignore-config', '--no-playlist', '--no-warnings',
      '--ies', 'default,-generic', '--js-runtimes', 'node', '--proxy', '',
      '-f', 'bestaudio/best', '--get-url', '--', extractorUrl
    ], { timeout: 45000, maxBuffer: 65536, killSignal: 'SIGKILL', env: childEnv }));
  } catch (e) {
    throw extractionFailure(e);
  }
  const links = String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (links.length !== 1) throw Error('Không tìm thấy đúng một luồng âm thanh công khai.');
  return validatePublicHttpsUrl(links[0], lookup);
}

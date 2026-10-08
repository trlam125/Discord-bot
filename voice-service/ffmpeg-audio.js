import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

const PROXY_ENV = /^(https?_proxy|all_proxy|no_proxy)$/i;

/**
 * Wait until FFmpeg outputs actual PCM, not merely until the process starts.
 * The PassThrough buffers initial PCM until Discord's player consumes it.
 */
export function prepareAudioStream(url, {
  spawnFn = spawn, signal, onSpawn = () => {}, timeoutMs = 18000
} = {}) {
  if (signal?.aborted) return Promise.reject(Error('Đã hủy phát nhạc.'));
  let proc;
  try {
    proc = spawnFn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'https,tls,tcp,crypto',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
      '-i', url, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !PROXY_ENV.test(k)))
    });
    onSpawn(proc);
  } catch {
    return Promise.reject(Error('Không chạy được FFmpeg.'));
  }
  const stream = new PassThrough({ highWaterMark: 65536 });
  proc.stdout.pipe(stream);
  proc.stderr?.on('data', () => { /* Never log signed stream URLs or credentials. */ });
  return new Promise((resolve, reject) => {
    let settled = false;
    const waitMs = Math.max(3000, Math.min(30000, Number(timeoutMs) || 18000));
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('readable', onReady);
      proc.off('close', onClose);
      proc.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const done = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        proc.kill('SIGKILL');
        stream.destroy();
        reject(err);
      } else resolve({ proc, stream });
    };
    const onReady = () => done(null);
    const onClose = () => done(Error('FFmpeg không nhận được âm thanh từ nguồn.'));
    const onError = () => done(Error('FFmpeg không thể mở nguồn âm thanh.'));
    const onAbort = () => done(Error('Đã hủy phát nhạc.'));
    const timer = setTimeout(() => done(Error('Nguồn không gửi âm thanh trong thời gian cho phép.')), waitMs);
    stream.once('readable', onReady);
    proc.once('close', onClose);
    proc.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (stream.readableLength > 0) onReady();
  });
}

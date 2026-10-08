import test from 'node:test';
import assert from 'node:assert/strict';
import { publicVoiceError, voiceQueueSummary } from '../public-messages.js';

test('public error messages contain no raw diagnostics, URLs or tokens', () => {
  const err = new Error('ffmpeg failed: https://private.example/audio?token=secret at /opt/service/index.js');
  const message = publicVoiceError(err);
  assert.equal(message, 'Không thể xử lý yêu cầu. Vui lòng thử lại.');
  assert.doesNotMatch(message, /https|token|ffmpeg|service/);
  assert.equal(publicVoiceError(new Error('Bạn cần vào phòng thoại trước khi /play')),
    'Bạn cần vào phòng thoại trước khi /play');
});

test('queue summary hides all source URLs', () => {
  const status = voiceQueueSummary({
    current: { url: 'https://example.test/current?token=abc' },
    queue: [{ url: 'https://example.test/next?token=xyz' }]
  });
  assert.equal(status, 'Đang phát nhạc. Hàng đợi: 1 bài.');
  assert.doesNotMatch(status, /https|token/);
});

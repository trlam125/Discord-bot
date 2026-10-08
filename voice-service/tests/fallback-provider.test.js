import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackConfigured, resolveFallbackMedia } from '../fallback-provider.js';

const dns = async () => [{ address: '1.1.1.1', family: 4 }];
const env = { MEDIA_FALLBACK_API_URL: 'https://provider.example.org/v1/resolve', MEDIA_FALLBACK_API_KEY: 'testkey' };
const json = data => new Response(JSON.stringify(data), {status:200, headers:{'Content-Type':'application/json'}});

test('fallback is opt-in, never invoked with empty API URL', async () => {
  assert.equal(fallbackConfigured({}), false);
  await assert.rejects(resolveFallbackMedia('https://youtube.com/watch?v=abc', {env:{},lookup:dns}), /chưa cấu hình/);
});

test('fallback sends original URL only to configured public provider and validates stream', async () => {
  let called = 0;
  const url = await resolveFallbackMedia('https://open.spotify.com/track/someid', {
    env, lookup:dns, fetchFn:async (endpoint, options) => {
      called++;
      assert.equal(endpoint, env.MEDIA_FALLBACK_API_URL);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer testkey');
      assert.equal(JSON.parse(options.body).url, 'https://open.spotify.com/track/someid');
      return json({stream_url:'https://cdn.example.org/song.m4a?token=signed'});
    }
  });
  assert.equal(called,1);
  assert.equal(url, 'https://cdn.example.org/song.m4a?token=signed');
});

test('fallback rejects internal, HTTP and malformed provider/media URLs', async () => {
  for (const endpoint of ['http://provider.example.org/resolve', 'https://127.0.0.1/resolve', 'https://metadata.internal/resolve']) {
    await assert.rejects(resolveFallbackMedia('https://youtube.com/watch?v=abc', {
      env:{...env,MEDIA_FALLBACK_API_URL:endpoint},lookup:dns,fetchFn:()=>{throw Error('must not call');}
    }));
  }
  for (const stream_url of ['http://cdn.example.org/audio.mp3', 'https://10.0.0.2/audio.mp3', 'file:///etc/passwd', 'https://localhost/audio.mp3']) {
    await assert.rejects(resolveFallbackMedia('https://youtube.com/watch?v=abc', {
      env, lookup:dns, fetchFn:async()=>json({stream_url})
    }), /không an toàn/);
  }
});

test('fallback handles provider failures without exposing response or tokens', async () => {
  await assert.rejects(resolveFallbackMedia('https://youtube.com/watch?v=abc', {
    env,lookup:dns,fetchFn:async()=>new Response('PRIVATE_TOKEN xyz',{status:401})
  }), e => e.message === 'Nguồn trung gian: API trả HTTP 401.');
  await assert.rejects(resolveFallbackMedia('https://youtube.com/watch?v=abc', {
    env,lookup:dns,fetchFn:async()=>json({anything:'else'})
  }), /thiếu trường stream_url/);
  await assert.rejects(resolveFallbackMedia('https://youtube.com/watch?v=abc', {
    env,lookup:dns,fetchFn:async()=>new Response('x'.repeat(17000),{status:200})
  }), /quá lớn/);
});

test('fallback does not follow provider redirects (credential safety)', async () => {
  await resolveFallbackMedia('https://youtube.com/watch?v=abc', {
    env,lookup:dns,fetchFn:async(_, opts)=> {
      assert.equal(opts.redirect,'error');
      return json({stream_url:'https://cdn.example.org/file.mp3'});
    }
  });
});

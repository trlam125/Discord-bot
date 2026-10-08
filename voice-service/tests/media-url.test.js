import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIP, parsePublicHttpsUrl, validatePublicHttpsUrl, resolveMediaInput, probeDirectAudioUrl } from '../media-url.js';

const dns = async hostname => {
  if (hostname === 'private.example.org') return [{ address: '10.0.0.23', family: 4 }];
  if (hostname === 'mixed.example.org') return [{ address: '1.1.1.1', family: 4 }, { address: '169.254.169.254', family: 4 }];
  if (hostname === 'v6private.example.org') return [{ address: 'fd12::1', family: 6 }];
  if (hostname === 'ipv6.example.org') return [{ address: '2606:4700:4700::1111', family: 6 }];
  return [{ address: '1.1.1.1', family: 4 }];
};

test('IP rules reject AWS metadata, RFC1918, loopback, documentation and IPv6 intranet', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.51.100.1',
    '::1', 'fe80::1', 'fd00:ec2::254', '2001:db8::1', '2002:c0a8:101::']) {
    assert.equal(isPublicIP(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicIP(ip), true, ip);
});

test('syntax blocks HTTP, localhost, private IP, credentials, ports and malformed input', () => {
  for (const url of ['http://youtube.com/watch?v=1', 'https://localhost/audio.mp3',
    'https://a.local/test.mp3', 'https://10.2.3.4/a.mp3',
    'https://169.254.169.254/latest/meta-data', 'https://user:pass@example.org/a.mp3',
    'https://example.org:8443/a.mp3', 'https://example.org/a\n.mp3', 'file:///tmp/a.mp3',
    'https://[fd00:ec2::254]/audio.mp3', 'https://0x7f000001/a.mp3']) {
    assert.throws(() => parsePublicHttpsUrl(url), { name: 'Error' }, url);
  }
  assert.equal(parsePublicHttpsUrl('https://www.youtube.com/watch?v=abc#t=1'), 'https://www.youtube.com/watch?v=abc');
});

test('rejects DNS hosts resolving to private, special or mixed private/public IPs', async () => {
  for (const host of ['private.example.org', 'mixed.example.org', 'v6private.example.org']) {
    await assert.rejects(validatePublicHttpsUrl(`https://${host}/foo`, dns), /mạng riêng/);
  }
  await assert.doesNotReject(validatePublicHttpsUrl('https://ipv6.example.org/song.mp3', dns));
  await assert.rejects(validatePublicHttpsUrl('https://somehost.example.net/media', async () => { throw Error('ENOTFOUND'); }), /Không phân giải/);
});

test('direct audio URL does not require yt-dlp, even for previously unknown hosts', async () => {
  const got = await resolveMediaInput('https://cdn.music-example.org/music.mp3?sig=xyz', {
    lookup: dns, run: () => { throw Error('should not run'); }
  });
  assert.equal(got, 'https://cdn.music-example.org/music.mp3?sig=xyz');
});

test('supported sources auto-extract with generic fallback disabled and proxies cleared', async () => {
  let args, options;
  const url = await resolveMediaInput('https://www.youtube.com/watch?v=123', {
    lookup: dns,
    run: async (exe, argv, opts) => {
      assert.equal(exe, 'yt-dlp');
      args = argv; options = opts;
      return { stdout: 'https://stream.example.org/video.m3u8?signature=abc\n' };
    }
  });
  assert.equal(url, 'https://stream.example.org/video.m3u8?signature=abc');
  assert.deepEqual(args.slice(args.indexOf('--ies'), args.indexOf('--ies') + 2), ['--ies', 'default,-generic']);
  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('--no-playlist'));
  assert.deepEqual(args.slice(args.indexOf('--js-runtimes'), args.indexOf('--js-runtimes') + 2), ['--js-runtimes', 'node']);
  assert.ok(options.timeout <= 45000);
});

test('yt-dlp cannot hand ffmpeg an internal stream or a redirect target it exposes', async () => {
  await assert.rejects(resolveMediaInput('https://www.youtube.com/watch?v=123', {
    lookup: dns, run: async () => ({ stdout: 'https://private.example.org/internal.mp3\n' })
  }), /mạng riêng/);
  await assert.rejects(resolveMediaInput('https://www.youtube.com/watch?v=123', {
    lookup: dns, run: async () => ({ stdout: 'http://stream.example.org/music.mp3' })
  }), /HTTPS/);
  await assert.rejects(resolveMediaInput('https://www.youtube.com/watch?v=123', {
    lookup: dns, run: async () => ({ stdout: 'https://stream.example.org/a.mp3\nhttps://stream.example.org/b.mp3' })
  }), /một luồng/);
});

test('unsupported website returns a useful, non-sensitive error', async () => {
  await assert.rejects(resolveMediaInput('https://unknown.example.org/some/page', {
    lookup: dns, head: async () => ({ok:false}), run: async () => { throw { code: 1, stderr: 'private provider detail and cookie' }; }
  }), /yt-dlp không thể trích xuất/);
});


test('YouTube Radio URL extracts only the requested video', async () => {
  let args;
  await resolveMediaInput('https://www.youtube.com/watch?v=hO4X_mJSqPI&list=RDhO4X_mJSqPI&start_radio=1', {
    lookup: dns, run: async (_exe, argv) => {
      args = argv;
      return { stdout: 'https://stream.example.org/music.m3u8\n' };
    }
  });
  assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=hO4X_mJSqPI');
});

test('yt-dlp actionable error messages do not echo secrets or raw stderr', async () => {
  await assert.rejects(resolveMediaInput('https://www.youtube.com/watch?v=hO4X_mJSqPI', {
    lookup: dns, run: async () => { throw { stderr: 'WARNING: No supported JavaScript runtime was found. secret=PRIVATE' }; }
  }), /yt-dlp-ejs/);
  await assert.rejects(resolveMediaInput('https://www.youtube.com/watch?v=hO4X_mJSqPI', {
    lookup: dns, run: async () => { throw { stderr: 'Sign in to confirm you are not a bot, token SECRET' }; }
  }), /máy chủ hiện tại/);
});

test('tokenized CDN with octet-stream audio filename can play without yt-dlp', async () => {
  let headOptions;
  const url = 'https://files.workercdn.com/hash?token=abc&fn=song_128k.mp3';
  const output = await resolveMediaInput(url, {
    lookup: dns,
    head: async (_url, opts) => {
      headOptions = opts;
      return { ok: true, headers: new Headers({ 'content-type': 'application/octet-stream' }) };
    },
    run: async () => { throw Error('yt-dlp must not run for direct audio'); }
  });
  assert.equal(output, url);
  assert.equal(headOptions.method, 'HEAD');
  assert.equal(headOptions.redirect, 'error');
});

test('HEAD HTML does not bypass dedicated yt-dlp source extraction', async () => {
  assert.equal(await probeDirectAudioUrl('https://example.org/foo', async () => ({
    ok: true, headers: new Headers({'content-type':'text/html'})
  })), false);
  let used = false;
  await resolveMediaInput('https://music.example.org/page', {
    lookup: dns,
    head: async () => ({ok:true,headers:new Headers({'content-type':'text/html'})}),
    run: async () => { used = true; return {stdout:'https://cdn.example.org/song.mp3\n'}; }
  });
  assert.equal(used, true);
});

test('new URL limit accommodates signed CDN paths but still bounds input', () => {
  assert.equal(parsePublicHttpsUrl('https://cdn.example.org/'+ 'a'.repeat(1300)).length, 1324);
  assert.throws(() => parsePublicHttpsUrl('https://cdn.example.org/'+ 'a'.repeat(2100)), /quá dài/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIP, parsePublicHttpsUrl, validatePublicHttpsUrl, resolveMediaInput } from '../media-url.js';

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
  assert.ok(options.timeout <= 30000);
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
    lookup: dns, run: async () => { throw { code: 1, stderr: 'private provider detail and cookie' }; }
  }), /yt-dlp không hỗ trợ/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { prepareAudioStream } from '../ffmpeg-audio.js';

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; process.nextTick(() => proc.emit('close',null)); };
  return proc;
}

test('decoder is considered playing only after it emits PCM bytes', async () => {
  const proc = fakeProcess();
  const result = prepareAudioStream('https://cdn.example.org/song.mp3', {
    spawnFn:(_exe, args)=> {
      assert.ok(args.includes('-protocol_whitelist'));
      process.nextTick(()=>proc.stdout.write(Buffer.from([1,2,3,4])));
      return proc;
    }
  });
  const { stream, proc: returned } = await result;
  assert.equal(returned, proc);
  assert.deepEqual(stream.read(), Buffer.from([1,2,3,4]));
  proc.kill();
});

test('a decoder that exits before output triggers fallback opportunity', async () => {
  const proc = fakeProcess();
  await assert.rejects(prepareAudioStream('https://cdn.example.org/song.mp3', {
    spawnFn: () => { process.nextTick(()=>proc.emit('close', 1)); return proc; }
  }), /không nhận được âm thanh/);
});

test('skip cancellation stops the decoder while waiting for first audio', async () => {
  const proc = fakeProcess();
  const controller = new AbortController();
  const promise = prepareAudioStream('https://cdn.example.org/song.mp3', {
    signal:controller.signal,spawnFn:()=>proc
  });
  controller.abort();
  await assert.rejects(promise, /Đã hủy/);
  assert.equal(proc.killed,true);
});

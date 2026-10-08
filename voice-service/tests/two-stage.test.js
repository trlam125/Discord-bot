import test from 'node:test';
import assert from 'node:assert/strict';
import { tryPrimaryThenFallback } from '../two-stage.js';

test('successful primary never invokes provider', async () => {
  let providerCalls=0;
  const answer = await tryPrimaryThenFallback(async()=> 'direct audio',async()=>{providerCalls++;return 'fallback audio';},()=>true);
  assert.equal(answer,'direct audio');
  assert.equal(providerCalls,0);
});

test('primary failure tries intermediary exactly once', async () => {
  let providerCalls=0;
  const answer = await tryPrimaryThenFallback(async()=>{throw Error('YouTube IP rejected');},async()=>{providerCalls++;return 'fallback audio';},()=>true);
  assert.equal(answer,'fallback audio');
  assert.equal(providerCalls,1);
});

test('no provider configured means primary error is preserved', async () => {
  let providerCalls=0;
  await assert.rejects(tryPrimaryThenFallback(async()=>{throw Error('direct failed');},async()=>{providerCalls++;},()=>false), /direct failed/);
  assert.equal(providerCalls,0);
});

test('fallback failure surfaces once, never retry loops', async () => {
  let providerCalls=0;
  await assert.rejects(tryPrimaryThenFallback(async()=>{throw Error('direct failed');},async()=>{providerCalls++;throw Error('provider failed');},()=>true), /provider failed/);
  assert.equal(providerCalls,1);
});

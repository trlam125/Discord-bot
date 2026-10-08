import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { __test } from '../src/index.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const demoApp = {
  steam_appid: 570, name: 'Dota 2', is_free: true,
  header_image: 'https://cdn.cloudflare.steamstatic.com/steam/apps/570/header.jpg',
  short_description: '<b>Dota</b> &amp; friends', about_the_game: '<p>Heroes and items</p>',
  release_date: { date: '9 Jul, 2013' }, genres: [{ description: 'Action' }],
  categories: [{ description: 'Multiplayer' }], developers: ['Valve'], publishers: ['Valve'],
  platforms: { windows: true, linux: true, mac: false },
  recommendations: { total: 25000 }, screenshots: [{ path_full: 'https://example.com/pic.jpg' }],
  pc_requirements: { minimum: '<b>Windows 10</b>', recommended: '8 GB RAM' },
  supported_languages: '<b>English</b>', dlc: [123, 456]
};

async function fixture() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { pubHex: Buffer.from(pub).toString('hex'), privateKey: pair.privateKey };
}

async function sign(payload, key, override) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(timestamp + body)));
  return new Request('https://example.workers.dev', { method: 'POST', headers: {
    'X-Signature-Ed25519': Buffer.from(sig).toString('hex'), 'X-Signature-Timestamp': timestamp
  }, body: override || body });
}

function makeContext() {
  const pending = [];
  return { pending, ctx: { waitUntil(p) { pending.push(p); } } };
}

function sample(type, command = 'steam', opts = []) {
  return { id: '1400000000000000000', type, application_id: '1300000000000000000',
    token: 'TEST_INTERACTION_TOKEN', guild_id: '1200000000000000000', channel_id: '1100000000000000000',
    member: { user: { id: '1000000000000000000', username: 'tester', avatar: null, discriminator: '0' }, roles: ['2'], joined_at: '2025-03-04T09:00:00Z' },
    data: { name: command, options: opts } };
}

function fakeDatabase() {
  const rows = [];
  let seq = 0;
  return { rows, prepare(query) {
    return { bind(...params) {
      return {
        async first() {
          if (query.includes('COUNT(*)')) return { total: rows.filter(x => x.guild_id === params[0] && x.user_id === params[1] && ['pending', 'processing'].includes(x.status)).length };
          return null;
        },
        async all() {
          if (query.includes('SELECT * FROM reminders')) return { results: rows.filter(x => x.status === 'pending' && x.next_attempt_at <= params[0]) };
          if (query.includes('SELECT id,title,due_at,status')) return { results: rows.filter(x => x.guild_id === params[0] && x.user_id === params[1] && ['pending', 'processing', 'failed'].includes(x.status)) };
          return { results: [] };
        },
        async run() {
          if (query.startsWith('INSERT INTO reminders')) {
            const [guild_id, user_id, channel_id, title, due_at, next_attempt_at, created_at] = params;
            rows.push({ id: ++seq, guild_id, user_id, channel_id, title, due_at, next_attempt_at, created_at, attempts: 0, status: 'pending' });
            return { meta: { last_row_id: seq, changes: 1 } };
          }
          if (query.startsWith('DELETE FROM reminders')) {
            const n = rows.findIndex(x => x.id === params[0] && x.user_id === params[1] && x.guild_id === params[2] && ['pending', 'failed'].includes(x.status));
            if (n >= 0) rows.splice(n, 1);
            return { meta: { changes: n >= 0 ? 1 : 0 } };
          }
          if (query.includes('locked_at <')) return { meta: { changes: 0 } };
          if (query.includes("status='processing',attempts=attempts+1")) {
            const row = rows.find(x => x.id === params[1] && x.status === 'pending');
            if (!row) return { meta: { changes: 0 } };
            row.status = 'processing'; row.attempts++; row.locked_at = params[0];
            return { meta: { changes: 1 } };
          }
          if (query.includes("status='sent'")) {
            const row = rows.find(x => x.id === params[1]); row.status = 'sent'; row.sent_at = params[0];
            return { meta: { changes: 1 } };
          }
          if (query.startsWith('UPDATE reminders SET status=?')) {
            const row = rows.find(x => x.id === params[3]);
            row.status = params[0]; row.next_attempt_at = params[1]; row.last_error = params[2];
            return { meta: { changes: 1 } };
          }
          throw Error('Unhandled SQL test query: ' + query);
        }
      };
    } };
  } };
}

test('parseWhen handles UTC+7, relative durations and invalid input', () => {
  const base = Date.UTC(2026, 9, 8, 3);
  assert.equal(__test.parseWhen('30m', base), base + 30 * 60000);
  assert.equal(__test.parseWhen('2h', base), base + 2 * 3600000);
  assert.equal(__test.parseWhen('2026-10-08 10:00'), base);
  assert.equal(__test.parseWhen('2026-10-08T03:00:00Z'), base);
  assert.equal(__test.parseWhen('2026-02-29 10:00'), null);
  assert.equal(__test.parseWhen('tomorrow'), null);
});

test('extractAppId handles numeric ids and Steam URLs only', () => {
  assert.equal(__test.extractAppId('570'), '570');
  assert.equal(__test.extractAppId('https://store.steampowered.com/app/570/Dota_2'), '570');
  assert.equal(__test.extractAppId('portal 2'), null);
  assert.equal(__test.extractAppId('0000'), null);
});

test('Steam pages include valid embeds and interactive buttons', () => {
  for (let page = 0; page < 4; page++) {
    const data = __test.makeSteamPage(demoApp, '570', page, '1000000000000000000');
    assert.equal(data.embeds[0].title, 'Dota 2');
    assert.equal(data.components[0].components.length, 4);
    assert.equal(data.components[1].components.length, 2);
    for (const f of data.embeds[0].fields) assert.ok(f.value.length <= 1024);
  }
  assert.equal(__test.removeHtml('<p>A &amp; B</p>'), 'A & B');
});

test('signature: rejects unsigned/tampered requests, accepts signed Discord ping', async () => {
  const keys = await fixture();
  const env = { DISCORD_PUBLIC_KEY: keys.pubHex };
  let result = await worker.fetch(new Request('https://example.workers.dev', { method: 'POST', body: JSON.stringify({ type: 1 }) }), env, makeContext().ctx);
  assert.equal(result.status, 401);
  result = await worker.fetch(await sign({ type: 1 }, keys.privateKey, JSON.stringify({ type: 2 })), env, makeContext().ctx);
  assert.equal(result.status, 401);
  result = await worker.fetch(await sign({ type: 1 }, keys.privateKey), env, makeContext().ctx);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { type: 1 });
});

test('Steam autocomplete and full AppID lookup with async original reply', async () => {
  const keys = await fixture();
  const oldFetch = globalThis.fetch;
  const edits = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.includes('storesearch')) return Response.json({ items: [{ id: 570, name: 'Dota 2', type: 'app' }, { id: 400, name: 'Portal', type: 'app' }] });
    if (path.includes('appdetails')) return Response.json({ '570': { success: true, data: demoApp } });
    if (path.includes('appreviews')) return Response.json({ query_summary: { review_score_desc: 'Very Positive', total_reviews: 100, total_positive: 94 } });
    if (path.includes('GetNumberOfCurrentPlayers')) return Response.json({ response: { result: 1, player_count: 1200 } });
    if (path.includes('/webhooks/')) { edits.push(JSON.parse(options.body)); return Response.json({}); }
    throw Error('Unexpected URL ' + path);
  };
  try {
    const env = { DISCORD_PUBLIC_KEY: keys.pubHex };
    const completion = sample(4, 'steam', [{ name: 'query', focused: true, type: 3, value: 'dota' }]);
    let result = await worker.fetch(await sign(completion, keys.privateKey), env, makeContext().ctx);
    assert.equal(result.status, 200);
    const suggestions = await result.json();
    assert.equal(suggestions.type, 8);
    assert.equal(suggestions.data.choices[0].value, '570');

    const context = makeContext();
    const steam = sample(2, 'steam', [{ name: 'query', value: '570', type: 3 }]);
    result = await worker.fetch(await sign(steam, keys.privateKey), env, context.ctx);
    assert.equal((await result.json()).type, 5);
    await Promise.all(context.pending);
    assert.equal(edits[0].embeds[0].title, 'Dota 2');
    assert.ok(edits[0].embeds[0].fields.some(x => x.value.includes('94%')));
    assert.ok(edits[0].embeds[0].fields.some(x => x.value.includes('1,200')));
    assert.equal(edits[0].components[0].components[0].custom_id, 'steam:page:570:0:1000000000000000000');
  } finally { globalThis.fetch = oldFetch; }
});

test('Steam result selection cannot be controlled by another member', async () => {
  const keys = await fixture();
  const interaction = sample(3, 'steam');
  interaction.data.custom_id = 'steam:page:570:2:999999999999999999';
  const result = await worker.fetch(await sign(interaction, keys.privateKey), { DISCORD_PUBLIC_KEY: keys.pubHex }, makeContext().ctx);
  assert.equal((await result.json()).data.flags, 64);
});

test('D1 reminder creation and scheduled dispatch via Discord REST', async () => {
  const keys = await fixture();
  const env = { DISCORD_PUBLIC_KEY: keys.pubHex, DISCORD_BOT_TOKEN: 'test-bot-token', DB: fakeDatabase() };
  const reminder = sample(2, 'remind', [{ name: 'create', type: 1, options: [
    { name: 'event', type: 3, value: 'Lan party' }, { name: 'when', type: 3, value: '2m' }
  ] }]);
  const created = await worker.fetch(await sign(reminder, keys.privateKey), env, makeContext().ctx);
  assert.equal((await created.json()).type, 4);
  assert.equal(env.DB.rows.length, 1);
  const messages = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    assert.match(String(url), /\/channels\/\d+\/messages$/);
    messages.push(JSON.parse(options.body));
    return Response.json({ id: '1234' });
  };
  try {
    await __test.processReminders(env, env.DB.rows[0].due_at + 1000);
    assert.equal(env.DB.rows[0].status, 'sent');
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /Lan party/);
    assert.deepEqual(messages[0].allowed_mentions.users, ['1000000000000000000']);
  } finally { globalThis.fetch = oldFetch; }
});

test('Steam search by partial name displays select menu and selection loads game', async () => {
  const keys = await fixture();
  const oldFetch = globalThis.fetch;
  const edited = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('storesearch')) return Response.json({ items: [
      { type: 'app', id: 570, name: 'Dota 2' }, { type: 'app', id: 400, name: 'Portal' }
    ] });
    if (u.includes('appdetails')) return Response.json({ '570': { success: true, data: demoApp } });
    if (u.includes('appreviews')) return Response.json({ query_summary: { total_reviews: 0 } });
    if (u.includes('GetNumberOfCurrentPlayers')) return Response.json({ response: { result: 1, player_count: 200 } });
    if (u.includes('/webhooks/')) { edited.push(JSON.parse(options.body)); return Response.json({}); }
    throw Error('Unmocked ' + u);
  };
  try {
    const env = { DISCORD_PUBLIC_KEY: keys.pubHex };
    const ctx1 = makeContext();
    const query = sample(2, 'steam', [{ type: 3, name: 'query', value: 'dota' }]);
    const ack1 = await worker.fetch(await sign(query, keys.privateKey), env, ctx1.ctx);
    assert.equal((await ack1.json()).type, 5);
    await Promise.all(ctx1.pending);
    assert.equal(edited[0].components[0].components[0].type, 3);
    assert.equal(edited[0].components[0].components[0].options[0].value, '570');

    const picked = sample(3, 'steam');
    picked.data.custom_id = edited[0].components[0].components[0].custom_id;
    picked.data.values = ['570'];
    const ctx2 = makeContext();
    const ack2 = await worker.fetch(await sign(picked, keys.privateKey), env, ctx2.ctx);
    assert.equal((await ack2.json()).type, 6);
    await Promise.all(ctx2.pending);
    assert.equal(edited[1].embeds[0].title, 'Dota 2');
  } finally { globalThis.fetch = oldFetch; }
});

test('member responds immediately from Discord interaction payload without fetching API', async () => {
  const keys = await fixture();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('Unexpected Discord API or webhook request'); };
  try {
    const ctx = makeContext();
    const interaction = sample(2, 'member');
    interaction.data.resolved = { roles: { '2': { id: '2', name: 'Moderator' } } };
    const response = await worker.fetch(await sign(interaction, keys.privateKey),
      { DISCORD_PUBLIC_KEY: keys.pubHex }, ctx.ctx);
    const payload = await response.json();
    assert.equal(payload.type, 4);
    assert.equal(ctx.pending.length, 0);
    const embed = payload.data.embeds[0];
    assert.ok(embed.fields.some(x => x.name === 'Roles (1)' && x.value === 'Moderator'));
    assert.ok(embed.fields.some(x => x.value === '1000000000000000000'));
    assert.equal(embed.thumbnail.url, __test.avatarUrl(interaction.member.user));
  } finally { globalThis.fetch = oldFetch; }
});

test('avatar for self responds with type 4 instantly and does not need Bot Token', async () => {
  const keys = await fixture();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('Unexpected external fetch'); };
  try {
    const ctx = makeContext();
    const interaction = sample(2, 'avatar');
    interaction.member.avatar = 'guild-avatar';
    const response = await worker.fetch(await sign(interaction, keys.privateKey),
      { DISCORD_PUBLIC_KEY: keys.pubHex }, ctx.ctx);
    const payload = await response.json();
    assert.equal(payload.type, 4);
    assert.equal(ctx.pending.length, 0);
    assert.match(payload.data.embeds[0].image.url, /guilds\/1200000000000000000\/users\/1000000000000000000\/avatars\/guild-avatar/);
    assert.equal(payload.data.components[0].components.length, 2);
  } finally { globalThis.fetch = oldFetch; }
});

test('avatar for a selected member uses resolved data without Bot Token or outbound API', async () => {
  const keys = await fixture();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('Unexpected external fetch'); };
  try {
    const selectedId = '999999999999999999';
    const interaction = sample(2, 'avatar', [{ name: 'user', type: 6, value: selectedId }]);
    interaction.data.resolved = {
      users: { [selectedId]: { id: selectedId, username: 'friend', global_name: 'A Friend', avatar: 'abcd' } },
      members: { [selectedId]: { nick: 'Nickname', avatar: null, roles: [], joined_at: '2026-01-01T00:00:00Z' } }
    };
    const response = await worker.fetch(await sign(interaction, keys.privateKey),
      { DISCORD_PUBLIC_KEY: keys.pubHex }, makeContext().ctx);
    const payload = await response.json();
    assert.equal(payload.type, 4);
    assert.equal(payload.data.embeds[0].title, 'Avatar: A Friend');
    assert.match(payload.data.embeds[0].image.url, /999999999999999999\/abcd.png/);
  } finally { globalThis.fetch = oldFetch; }
});

test('missing resolved user returns immediate visible error', async () => {
  const keys = await fixture();
  const interaction = sample(2, 'avatar', [{ name: 'user', value: '999999999999999999' }]);
  const response = await worker.fetch(await sign(interaction, keys.privateKey),
    { DISCORD_PUBLIC_KEY: keys.pubHex }, makeContext().ctx);
  const payload = await response.json();
  assert.equal(payload.type, 4);
  assert.equal(payload.data.flags, 64);
  assert.match(payload.data.content, /không gửi đủ/);
});

test('reminder list/cancel restrict ownership', async () => {
  const keys = await fixture();
  const env = { DISCORD_PUBLIC_KEY: keys.pubHex, DB: fakeDatabase() };
  const create = sample(2, 'remind', [{ name: 'create', options: [
    { name: 'event', value: 'Meeting' }, { name: 'when', value: '1d' }
  ] }]);
  await worker.fetch(await sign(create, keys.privateKey), env, makeContext().ctx);
  const list = sample(2, 'remind', [{ name: 'list' }]);
  const listResponse = await worker.fetch(await sign(list, keys.privateKey), env, makeContext().ctx);
  assert.match((await listResponse.json()).data.content, /Meeting/);
  const cancel = sample(2, 'remind', [{ name: 'cancel', options: [{ name: 'id', value: 1 }] }]);
  cancel.member.user.id = '999999999999999999';
  const denied = await worker.fetch(await sign(cancel, keys.privateKey), env, makeContext().ctx);
  assert.match((await denied.json()).data.content, /Kh\u00f4ng t\u00ecm th\u1ea5y/);
  assert.equal(env.DB.rows.length, 1);
  cancel.member.user.id = '1000000000000000000';
  const deleted = await worker.fetch(await sign(cancel, keys.privateKey), env, makeContext().ctx);
  assert.match((await deleted.json()).data.content, /h\u1ee7y/);
  assert.equal(env.DB.rows.length, 0);
});

test('failed Discord notification reaches max retry and is marked failed', async () => {
  const db = fakeDatabase();
  const row = { id: 5, guild_id: '123', user_id: '100', channel_id: '200', title: 'Important',
    due_at: 1000, next_attempt_at: 1000, created_at: 0, attempts: 4, status: 'pending' };
  db.rows.push(row);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });
  try {
    await __test.processReminders({ DB: db, DISCORD_BOT_TOKEN: 'test' }, 2000);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 5);
  } finally { globalThis.fetch = oldFetch; }
});

test('voice slash command queues job, polls securely and acknowledges completion', async () => {
  const keys = await fixture();
  const jobs = [];
  const env = {
    DISCORD_PUBLIC_KEY: keys.pubHex,
    VOICE_SHARED_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDE',
    DB: { prepare(sql) {
      return { bind(...params) {
        return {
          async run() {
            if (sql.startsWith('INSERT INTO voice_jobs')) {
              const [guild_id,user_id,channel_id,action,url,created_at] = params;
              jobs.push({ id: jobs.length + 1,guild_id,user_id,channel_id,action,url,created_at,status:'pending' });
              return { meta: { changes: 1, last_row_id: jobs.length } };
            }
            if (sql.includes("SET status='pending', claimed_at=NULL")) return { meta: { changes: 0 } };
            if (sql.includes("SET status='processing',claimed_at=?")) {
              const row = jobs.find(x => x.id === params[1] && x.status === 'pending');
              if (!row) return { meta: { changes: 0 } };
              row.status = 'processing';
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET status=?,finished_at=?,error=?')) {
              const row = jobs.find(x => x.id === params[3]);
              if (row) { row.status = params[0]; row.error = params[2]; }
              return { meta: { changes: row ? 1 : 0 } };
            }
            throw Error('Unexpected voice SQL: '+sql);
          }
        };
      }, async all() {
        if (!sql.includes('FROM voice_jobs')) throw Error('Unexpected select');
        return { results: jobs.filter(x => x.status === 'pending').map(x => ({...x})) };
      } };
    } }
  };
  const ctx = makeContext().ctx;
  const interaction = sample(2,'play',[{name:'url',type:3,value:'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'}]);
  let res = await worker.fetch(await sign(interaction,keys.privateKey), env,ctx);
  assert.equal(res.status,200);
  assert.match((await res.json()).data.content,/Đã nhận yêu cầu/);
  assert.equal(jobs.length,1);
  assert.equal(jobs[0].status,'pending');
  res = await worker.fetch(new Request('https://example.workers.dev/voice/jobs'),env,ctx);
  assert.equal(res.status,401);
  res = await worker.fetch(new Request('https://example.workers.dev/voice/jobs',{headers:{Authorization:`Bearer ${env.VOICE_SHARED_SECRET}`}}),env,ctx);
  assert.equal(res.status,200);
  const data = await res.json();
  assert.equal(data.jobs.length,1);
  assert.equal(data.jobs[0].action,'play');
  assert.equal(jobs[0].status,'processing');
  res = await worker.fetch(new Request('https://example.workers.dev/voice/ack',{
    method:'POST',headers:{Authorization:`Bearer ${env.VOICE_SHARED_SECRET}`},body:JSON.stringify({id:1,ok:true})
  }),env,ctx);
  assert.equal(res.status,200);
  assert.equal(jobs[0].status,'done');
});

test('voice rejects invalid URL, no guild or missing voice service configuration', async () => {
  const keys = await fixture();
  const ctx = makeContext().ctx;
  const interaction = sample(2,'play',[{name:'url',type:3,value:'file:///etc/passwd'}]);
  const env = {DISCORD_PUBLIC_KEY:keys.pubHex,VOICE_SHARED_SECRET:'test-secret'};
  const res = await worker.fetch(await sign(interaction,keys.privateKey),env,ctx);
  const data = await res.json();
  assert.match(data.data.content,/Chưa cấu hình Voice Service/);
  const fakeDB = { prepare(){ throw Error('Should not insert invalid URL'); } };
  const res2= await worker.fetch(await sign(interaction,keys.privateKey),{...env,DB:fakeDB},ctx);
  assert.match((await res2.json()).data.content,/HTTPS hợp lệ/);
});

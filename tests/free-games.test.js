import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { __freeTest, freeButton, freeCommand, freeCron } from '../src/free-games.js';

const FIXED_NOW = Date.UTC(2026,9,8,13);
const GUILD_A = '1200000000000000000';
const GUILD_B = '1200000000000000001';
const CHANNEL = '1100000000000000000';
const ROLE = '1300000000000000000';
const USER = '1000000000000000000';

function gp(id, type='Game', worth='$19.99', platforms='PC, Steam', title='Free paid title') {
  return { id, type, worth, title, platforms, status:'Active', description:'Claim this giveaway before the deadline.',
    published_date: '2026-10-08 13:00:00', end_date: '2026-11-08 15:00:00',
    open_giveaway_url: `https://www.gamerpower.com/open/${id}`, gamerpower_url: `https://www.gamerpower.com/giveaway/${id}`,
    image: 'https://www.gamerpower.com/offers/example.jpg' };
}
function epic(id, now = FIXED_NOW, active=true) {
  return { id, title:'Epic Game', offerType:'BASE_GAME', description:'Paid game promotion',
    keyImages:[{ type:'OfferImageWide',url:'https://cdn.epicgames.com/game.jpg'}],
    catalogNs:{ mappings:[{ pageSlug:'epic-game' }] },
    price:{ totalPrice:{ originalPrice:2499, currencyCode:'USD',currencyInfo:{decimals:2} } },
    promotions:{ promotionalOffers: active ? [{ promotionalOffers:[{ startDate:new Date(now-1000).toISOString(),endDate:new Date(now+86400000).toISOString(),discountSetting:{discountPercentage:0}}]}] : [],
      upcomingPromotionalOffers: active?[]:[{promotionalOffers:[{startDate:new Date(now+3600000).toISOString(),endDate:new Date(now+86400000).toISOString(),discountSetting:{discountPercentage:0}}]}] } };
}
function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../free-games.sql', import.meta.url),'utf8'));
  const wrap = (sql,values=[]) => {
    const stmt = sqlite.prepare(sql);
    return {
      bind(...args) { return wrap(sql,args); },
      async first() { return stmt.get(...values) || null; },
      async all() { return { results: stmt.all(...values) }; },
      async run() { const r=stmt.run(...values);return { meta:{changes:r.changes,last_row_id:r.lastInsertRowid} }; }
    };
  };
  return { sqlite, prepare: sql=>wrap(sql), batch:async xs=>{const r=[];for (const x of xs) r.push(await x.run());return r;} };
}
function setGuild(db, {guild=GUILD_A,store='all',kinds='game',bootstrapped=0,enabled=1,role=null,upcoming=0,minPrice=0.01}={}) {
  db.sqlite.prepare('INSERT INTO free_settings(guild_id,channel_id,role_id,stores,kinds,min_price,notify_upcoming,theme,enabled,bootstrapped,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(guild,CHANNEL,role,store,kinds,minPrice,upcoming,'rich',enabled,bootstrapped,FIXED_NOW);
}
function mockNetwork(getState, posts) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url,opts={})=>{
    const href=String(url);
    if (href.includes('gamerpower.com/api')) return Response.json(getState().gp);
    if (href.includes('freeGamesPromotions')) return Response.json({ data:{ Catalog:{ searchStore:{ elements:getState().epic } } } });
    if (href.includes('discord.com/api/v10/channels/')) { posts.push({url:href,body:JSON.parse(opts.body)});return Response.json({id:'123'}); }
    throw new Error('Unexpected network request: '+href);
  };
  return ()=>{globalThis.fetch=realFetch;};
}
function interaction(subcommand,options=[],perms='32') { return { guild_id:GUILD_A, member:{user:{id:USER},permissions:perms},
  application_id:'1100000000000000000',token:'interaction-token',data:{name:'free',options:[{name:subcommand,type:1,options:options.map(([name,value])=>({name,value}))}]} }; }

const preview = async (interaction,env) => {
  let reply;
  await __freeTest.runCommand(interaction,env,async (_i,data)=>{reply=data;});
  return reply;
};

test('GamerPower parsing filters free-to-play, expired and dangerous link; has no ping or secrets',()=>{
  const valid = __freeTest.giveawayToOffer(gp(7),FIXED_NOW);
  assert.equal(valid.store,'steam');
  assert.equal(valid.kind,'game');
  assert.equal(valid.original_price,19.99);
  assert.equal(valid.end_at,Date.UTC(2026,10,8,15));
  assert.equal(__freeTest.giveawayToOffer(gp(8,'Game','$0.00'),FIXED_NOW),null);
  assert.equal(__freeTest.giveawayToOffer({...gp(7),end_date:'2020-01-01 00:00:00'},FIXED_NOW),null);
  assert.equal(__freeTest.giveawayToOffer({...gp(7),open_giveaway_url:'javascript:alert(1)'},FIXED_NOW),null);
  assert.equal(__freeTest.priceNumber('$1,299.50'),1299.5);
  const msg=__freeTest.makePost(valid,{theme:'rich',role_id:ROLE});
  assert.equal(msg.allowed_mentions.roles[0],ROLE);
  assert.equal(msg.content,`<@&${ROLE}>`);
  assert.ok(msg.components[0].components.some(x=>x.label.includes('GamerPower')));
  assert.equal(__freeTest.makePost(valid,{role_id:ROLE},true).allowed_mentions.roles,undefined);
});

test('Epic parsing returns active and upcoming only for paid 100%-off offers',()=>{
  assert.equal(__freeTest.epicToOffers(epic('x'),FIXED_NOW)[0].phase,'active');
  const future=__freeTest.epicToOffers(epic('x',FIXED_NOW,false),FIXED_NOW);
  assert.equal(future[0].phase,'upcoming');
  assert.ok(future[0].claim_url.startsWith('https://store.epicgames.com/en-US/p/'));
  assert.equal(__freeTest.epicToOffers({...epic('x'),price:{totalPrice:{originalPrice:0}}},FIXED_NOW).length,0);
  const partial=epic('y');partial.promotions.promotionalOffers[0].promotionalOffers[0].discountSetting.discountPercentage=50;
  assert.equal(__freeTest.epicToOffers(partial,FIXED_NOW).length,0);
});

test('collectOffers merges feeds and prefers direct Epic over duplicate aggregator listing',async()=>{
  const fetcher = async url => Response.json(String(url).includes('gamerpower')
    ? [gp(1),gp(2,'Game','$9.99','Epic Games Store','Epic Game')]
    : {data:{Catalog:{searchStore:{elements:[epic('x')]}}}});
  const {offers,warnings}=await __freeTest.collectOffers(FIXED_NOW,fetcher);
  assert.equal(offers.length,2);
  assert.equal(offers.filter(x=>x.store==='epic').length,1);
  assert.deepEqual(warnings,[]);
});

test('initial sync sends eligible offers, subsequent polls send only newly undelivered deals and never ping everyone',async()=>{
  const db=makeDb();setGuild(db,{role:ROLE});setGuild(db,{guild:GUILD_B,store:'epic'});
  const current={gp:[gp(1)],epic:[]}; const posts=[];const restore=mockNetwork(()=>current,posts);
  const env={DB:db,DISCORD_BOT_TOKEN:'t'};
  try {
    await freeCron(env,FIXED_NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM free_deliveries').get().n,1);
    assert.equal(posts.length,1);
    assert.equal(db.sqlite.prepare('SELECT bootstrapped FROM free_settings WHERE guild_id=?').get(GUILD_A).bootstrapped,1);
    current.gp=[gp(1),gp(2,'Game','$12.00','PC, Steam','Fresh deal')];
    await freeCron(env,FIXED_NOW+15*60000);
    assert.equal(posts.length,2);
    assert.equal(posts[0].body.content,`<@&${ROLE}>`);
    assert.equal(posts[0].body.allowed_mentions.roles[0],ROLE);
    assert.equal(db.sqlite.prepare("SELECT status FROM free_deliveries WHERE guild_id=?").get(GUILD_A).status,'sent');
    await freeCron(env,FIXED_NOW+16*60000);
    assert.equal(posts.length,2);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM free_offers').get().n,2);
  } finally {restore();}
});

test('regression: active Epic offers already saved in D1 without deliveries are backfilled once', async()=>{
  const db=makeDb();setGuild(db,{bootstrapped:1,store:'epic'});
  const titles=['Out of Sight','TerraScape'];
  const current={gp:[],epic:titles.map((title,i)=>({...epic('promo-'+i,FIXED_NOW,true),title}))};
  for(const [i,title] of titles.entries()) {
    const offer=__freeTest.epicToOffers(current.epic[i],FIXED_NOW)[0];
    db.sqlite.prepare(`INSERT INTO free_offers
      (offer_key,source,store,kind,phase,title,claim_url,original_price,start_at,end_at,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(offer.offer_key,'epic','epic','game','active',title,offer.claim_url,14.99,offer.start_at,offer.end_at,FIXED_NOW-3600000,FIXED_NOW-60000);
  }
  const posts=[];const restore=mockNetwork(()=>current,posts);
  try {
    const env={DB:db,DISCORD_BOT_TOKEN:'t'};
    await freeCron(env,FIXED_NOW);
    assert.deepEqual(posts.map(p=>p.body.embeds[0].title).sort(),titles);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM free_deliveries WHERE status='sent'").get().n,2);
    await freeCron(env,FIXED_NOW+15*60000);
    assert.equal(posts.length,2,'do not resend on next poll');
  } finally {restore();}
});

test('backfill only currently confirmed live offers and honors disabled guilds and game filters',async()=>{
  const db=makeDb();setGuild(db,{bootstrapped:1,store:'steam'});setGuild(db,{guild:GUILD_B,bootstrapped:1,store:'epic',enabled:0});
  const existing=__freeTest.epicToOffers(epic('stale',FIXED_NOW,true),FIXED_NOW)[0];
  db.sqlite.prepare(`INSERT INTO free_offers (offer_key,source,store,kind,phase,title,claim_url,original_price,start_at,end_at,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(existing.offer_key,'epic','epic','game','active','Stale title',existing.claim_url,20,existing.start_at,existing.end_at,FIXED_NOW-100000,FIXED_NOW-60000);
  const state={gp:[gp(1)],epic:[]}, posts=[];const restore=mockNetwork(()=>state,posts);
  try {
    const env={DB:db,DISCORD_BOT_TOKEN:'t'};
    await freeCron(env,FIXED_NOW);
    assert.equal(posts.length,1,'only Steam deal received');
    assert.equal(posts[0].body.embeds[0].title,'Free paid title');
    db.sqlite.prepare("UPDATE free_settings SET enabled=1,stores='steam' WHERE guild_id=?").run(GUILD_B);
    await freeCron(env,FIXED_NOW+15*60000);
    assert.equal(posts.length,2,'newly enabled guild receives still-live offer');
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM free_deliveries WHERE offer_key=?").get(existing.offer_key).n,0);
  } finally {restore();}
});

test('Epic upcoming does not alert when disabled, but active phase notifies after launch', async()=>{
  const db=makeDb();setGuild(db,{bootstrapped:1,store:'epic',upcoming:0});
  const state={gp:[],epic:[epic('transition',FIXED_NOW,false)]},posts=[];
  const restore=mockNetwork(()=>state,posts);
  try {
    const env={DB:db,DISCORD_BOT_TOKEN:'t'};
    await freeCron(env,FIXED_NOW);
    assert.equal(posts.length,0);
    const promo=state.epic[0].promotions.upcomingPromotionalOffers[0].promotionalOffers[0];
    state.epic[0].promotions={upcomingPromotionalOffers:[],promotionalOffers:[{promotionalOffers:[promo]}]};
    await freeCron(env,FIXED_NOW+2*3600000);
    assert.equal(posts.length,1);
    assert.equal(db.sqlite.prepare("SELECT o.phase FROM free_deliveries d JOIN free_offers o USING (offer_key)").get().phase,'active');
  } finally {restore();}
});

test('a different Epic promotion next month is notified once again',async()=>{
  const db=makeDb();setGuild(db,{bootstrapped:1,store:'epic'});
  const state={gp:[],epic:[epic('repeat',FIXED_NOW,true)]},posts=[];
  const restore=mockNetwork(()=>state,posts);
  try {
    const env={DB:db,DISCORD_BOT_TOKEN:'t'};
    await freeCron(env,FIXED_NOW);
    assert.equal(posts.length,1);
    const again=FIXED_NOW+40*86400000;
    state.epic=[epic('repeat',again,true)];
    await freeCron(env,again);
    assert.equal(posts.length,2);
    assert.equal(db.sqlite.prepare("SELECT COUNT(DISTINCT offer_key) AS n FROM free_deliveries").get().n,1,
      'delivery for the expired promotion is pruned after 30 days');
    assert.equal(db.sqlite.prepare("SELECT o.start_at FROM free_deliveries d JOIN free_offers o USING(offer_key)").get().start_at, again-1000);
    await freeCron(env,again+15*60000);
    assert.equal(posts.length,2);
  } finally {restore();}
});

test('a long-running deal does not re-notify after 30 days of history retention',async()=>{
  const db=makeDb();setGuild(db,{bootstrapped:1,store:'epic'});
  const original=epic('long',FIXED_NOW,true);
  original.promotions.promotionalOffers[0].promotionalOffers[0].endDate=new Date(FIXED_NOW+65*86400000).toISOString();
  const state={gp:[],epic:[original]},posts=[];const restore=mockNetwork(()=>state,posts);
  try {
    const env={DB:db,DISCORD_BOT_TOKEN:'t'};
    await freeCron(env,FIXED_NOW);
    await freeCron(env,FIXED_NOW+31*86400000);
    await freeCron(env,FIXED_NOW+32*86400000);
    assert.equal(posts.length,1);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM free_deliveries WHERE status='sent'").get().n,1);
  } finally {restore();}
});

test('different server store filters and upcoming setting produce separate notifications',async()=>{
  const db=makeDb();setGuild(db,{bootstrapped:1,store:'steam'});setGuild(db,{guild:GUILD_B,bootstrapped:1,store:'epic',upcoming:1});
  const state={gp:[gp(10)],epic:[epic('x',FIXED_NOW,true),epic('z',FIXED_NOW,false)]};const posts=[];
  const restore=mockNetwork(()=>state,posts);
  try {
    await freeCron({DB:db,DISCORD_BOT_TOKEN:'t'},FIXED_NOW);
    assert.equal(posts.length,3);
    const rows=db.sqlite.prepare("SELECT d.guild_id,o.store,o.phase FROM free_deliveries d JOIN free_offers o ON d.offer_key=o.offer_key ORDER BY o.offer_key").all();
    assert.equal(rows.filter(x=>x.guild_id===GUILD_A).length,1);
    assert.deepEqual(rows.filter(x=>x.guild_id===GUILD_B).map(x=>x.phase).sort(),['active','upcoming']);
  } finally {restore();}
});

test('Discord API 429 uses retry_after and subsequent cron sends pending work',async()=>{
  const db=makeDb();setGuild(db,{bootstrapped:1});const state={gp:[gp(20)],epic:[]};const posts=[];
  const old=globalThis.fetch; let fail=true;
  const restore=mockNetwork(()=>state,posts);const upstream=globalThis.fetch;
  globalThis.fetch=async (url,opts)=>{
    if (String(url).includes('discord.com/api') && fail) {fail=false;return new Response(JSON.stringify({retry_after:2}),{status:429,headers:{'content-type':'application/json'}});}
    return upstream(url,opts);
  };
  try {
    const env={DB:db,DISCORD_BOT_TOKEN:'t'};
    await freeCron(env,FIXED_NOW);
    assert.equal(posts.length,0);
    const pending=db.sqlite.prepare('SELECT status,next_attempt_at FROM free_deliveries').get();
    assert.equal(pending.status,'pending');
    assert.equal(pending.next_attempt_at,FIXED_NOW+2000);
    await freeCron(env,FIXED_NOW+3000);
    assert.equal(posts.length,1);
    assert.equal(db.sqlite.prepare('SELECT status FROM free_deliveries').get().status,'sent');
  } finally {restore();globalThis.fetch=old;}
});

test('admin command protects settings and persists filters/theme/role/toggle',async()=>{
  const db=makeDb();const env={DB:db,DISCORD_BOT_TOKEN:'t'};
  const denied=await preview(interaction('setup',[['channel',CHANNEL]],'0'),env);
  assert.match(denied.content,/Manage Server/);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM free_settings').get().n,0);
  const created=await preview(interaction('setup',[['channel',CHANNEL],['role',ROLE]]),env);
  assert.match(created.content,/Đã chọn kênh/);
  await preview(interaction('filter',[['stores','steam,epic'],['kinds','game,loot'],['min_price',5],['upcoming',true]]),env);
  await preview(interaction('theme',[['style','compact']]),env);
  let saved=db.sqlite.prepare('SELECT * FROM free_settings').get();
  assert.equal(saved.stores,'steam,epic');assert.equal(saved.kinds,'game,loot');assert.equal(saved.min_price,5);
  assert.equal(saved.notify_upcoming,1);assert.equal(saved.theme,'compact');assert.equal(saved.role_id,ROLE);
  await preview(interaction('mention',[['clear',true]]),env);
  await preview(interaction('toggle',[['enabled',false]]),env);
  saved=db.sqlite.prepare('SELECT * FROM free_settings').get();
  assert.equal(saved.role_id,null);assert.equal(saved.enabled,0);
  const invalid=await preview(interaction('filter',[['stores','steam,invalid']]),env);
  assert.match(invalid.content,/không hợp lệ/);
});

test('list is short, paginates, and search does not produce pagination that loses query',async()=>{
  const db=makeDb();const now=Date.now();
  for(let i=0;i<6;i++) db.sqlite.prepare(`INSERT INTO free_offers(offer_key,source,store,kind,phase,title,claim_url,original_price,first_seen_at,last_seen_at,end_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`gp:${i}`,'gamerpower','steam','game','active',`Game ${i}`,`https://example.com/game/${i}`,10,now,now,now+86400000);
  const view=await __freeTest.listOffers({DB:db},'active','all',0,USER);
  assert.equal(view.embeds.length,4);assert.equal(view.components.length,5);
  assert.equal(view.components.at(-1).components[1].disabled,false);
  const search=await __freeTest.listOffers({DB:db},'active','all',0,USER,'Game 1');
  assert.equal(search.embeds.length,1);assert.equal(search.components.length,1);
});

test('button rejects other user and command acknowledges ephemeral request',async()=>{
  const ctx={pending:[],waitUntil(p){this.pending.push(p);}};
  const intr=interaction('help');
  const result=freeCommand(intr,{DB:makeDb()},ctx,async()=>{});
  const reply=await result.json();
  assert.equal(reply.type,5);assert.equal(reply.data.flags,64);
  await Promise.all(ctx.pending);
  intr.data.custom_id=`free:page:active:all:4:999999999999999999`;
  const button=await freeButton(intr,{DB:makeDb()},ctx,async()=>{}).json();
  assert.equal(button.type,4);assert.equal(button.data.flags,64);
});


test('Discord 403 is permanent and expired retry is not posted',async()=>{
  const db=makeDb();setGuild(db,{bootstrapped:1});const state={gp:[gp(45)],epic:[]};let hits=0;
  const original=globalThis.fetch;
  const undo=mockNetwork(()=>state,[]);const upstream=globalThis.fetch;
  globalThis.fetch=async (url,opts)=>{
    if (String(url).includes('discord.com/api')) {hits++;return new Response('',{status:403});}
    return upstream(url,opts);
  };
  try {
    const env={DB:db,DISCORD_BOT_TOKEN:'token'};
    await freeCron(env,FIXED_NOW);
    assert.equal(hits,1);
    assert.equal(db.sqlite.prepare('SELECT status FROM free_deliveries').get().status,'failed');
    await freeCron(env,FIXED_NOW+60000);
    assert.equal(hits,1);
  } finally { undo();globalThis.fetch=original; }
});

test('pending notifications respect changed filters and never announce an expired promotion',async()=>{
  const db=makeDb();setGuild(db,{bootstrapped:1});
  const insert=(id,store,end)=>{
    db.sqlite.prepare(`INSERT INTO free_offers(offer_key,source,store,kind,phase,title,claim_url,original_price,first_seen_at,last_seen_at,end_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,'gamerpower',store,'game','active',id,`https://example.com/${id}`,10,FIXED_NOW,FIXED_NOW,end);
    db.sqlite.prepare('INSERT INTO free_deliveries(guild_id,offer_key,next_attempt_at) VALUES (?,?,?)').run(GUILD_A,id,FIXED_NOW);
  };
  insert('expired','steam',FIXED_NOW-1000);
  insert('filtered','steam',FIXED_NOW+3600000);
  db.sqlite.prepare("UPDATE free_settings SET stores='epic'").run();
  let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;return Response.json({id:'x'});};
  try {
    await __freeTest.dispatchOffers({DB:db,DISCORD_BOT_TOKEN:'token'},FIXED_NOW);
    assert.equal(calls,0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM free_deliveries WHERE status='failed'").get().n,2);
  } finally {globalThis.fetch=old;}
});

test('migration is idempotent and never alters pre-existing reminders',()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE reminders(id INTEGER PRIMARY KEY,title TEXT); INSERT INTO reminders(id,title) VALUES(1,'retained');");
  const migration=readFileSync(new URL('../free-games.sql', import.meta.url),'utf8');
  sqlite.exec(migration);sqlite.exec(migration);
  assert.equal(sqlite.prepare('SELECT title FROM reminders WHERE id=1').get().title,'retained');
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='free_offers'").get());
});

test('loot without price is only eligible when a server deliberately enables loot and zero min price',()=>{
  const loot=__freeTest.giveawayToOffer(gp(15,'Loot','N/A','PC, Steam','Rare item'),FIXED_NOW);
  assert.equal(loot.kind,'loot');
  assert.equal(loot.original_price,0);
  assert.equal(__freeTest.matchesSetting(loot,{enabled:1,stores:'all',kinds:'game',min_price:0.01,notify_upcoming:0}),false);
  assert.equal(__freeTest.matchesSetting(loot,{enabled:1,stores:'all',kinds:'loot',min_price:0,notify_upcoming:0}),true);
});

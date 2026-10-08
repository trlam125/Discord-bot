/** FreeStuff-inspired giveaway alerts. Works with existing Cloudflare Workers + D1.
 * GamerPower requires attribution: https://www.gamerpower.com/api-read
 * Epic's public storefront JSON is undocumented and may change without notice.
 */
const DISCORD_API = 'https://discord.com/api/v10';
const GAMERPOWER_ALL = 'https://www.gamerpower.com/api/giveaways';
const EPIC = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
const POLL_MS = 15 * 60000;
const FRESH_MS = 36 * 3600000;
const STORES = new Set(['steam', 'epic', 'gog', 'itch', 'other']);
const KINDS = new Set(['game', 'loot', 'beta']);
const MAX_POSTS_PER_TICK = 10;
const noMentions = { parse: [] };

function text(value, max = 300) { return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max); }
function plain(value, max = 300) { return text(value, max).replace(/<[^>]*>/g, '').replace(/@/g, '@\u200b'); }
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
function parseUtcTime(value) {
  if (typeof value !== 'string' || !value || value === 'N/A') return null;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}
function priceNumber(value) {
  if (typeof value === 'number') return value > 0 ? value : 0;
  const match = String(value || '').match(/\d[\d,]*(?:\.\d+)?/);
  const v = match ? Number(match[0].replace(/,/g, '')) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function storeFromPlatforms(value) {
  const p = String(value || '').toLowerCase();
  if (p.includes('steam')) return 'steam';
  if (p.includes('epic')) return 'epic';
  if (p.includes('gog')) return 'gog';
  if (p.includes('itch')) return 'itch';
  return 'other';
}
function kindFromType(value) {
  const t = String(value || '').toLowerCase();
  if (t.includes('beta') || t.includes('early access')) return 'beta';
  if (t.includes('loot') || t.includes('dlc') || t.includes('item')) return 'loot';
  return 'game';
}
function giveawayToOffer(item, now) {
  if (!item || !Number.isSafeInteger(Number(item.id)) || Number(item.id) < 1) return null;
  if (String(item.status || 'active').toLowerCase() !== 'active') return null;
  const title = plain(item.title, 180).replace(/\s*\([^()]*\)\s*giveaway$/i, '').replace(/\s+giveaway$/i, '');
  const worth = priceNumber(item.worth);
  const kind = kindFromType(item.type);
  const url = safeUrl(item.open_giveaway_url || item.open_giveaway || item.gamerpower_url);
  const end = parseUtcTime(item.end_date);
  if (!title || !url || (!worth && kind === 'game') || (end !== null && end <= now)) return null;
  return {
    offer_key: `gp:${item.id}:active`, source: 'gamerpower', store: storeFromPlatforms(item.platforms),
    kind, phase: 'active', title,
    description: plain(item.description, 700), image_url: safeUrl(item.image || item.thumbnail),
    claim_url: url, source_url: safeUrl(item.gamerpower_url) || 'https://www.gamerpower.com',
    original_price: worth, currency: 'USD', start_at: parseUtcTime(item.published_date), end_at: end
  };
}
function epicOfferSlug(item) {
  const slug = item?.catalogNs?.mappings?.find(x => x?.pageSlug)?.pageSlug || item?.productSlug || item?.urlSlug || '';
  const cleaned = String(slug).replace(/\/home\/?$/, '').replace(/^\/+|\/+$/g, '');
  if (!cleaned || !/^[\w-]+(?:\/[\w-]+)*$/.test(cleaned) || cleaned.includes('..')) return null;
  return `https://store.epicgames.com/en-US/p/${cleaned}`;
}
function epicToOffers(item, now) {
  if (!item?.id || !item?.title || !item.promotions) return [];
  if (item.offerType && !['BASE_GAME', 'BUNDLE'].includes(item.offerType)) return [];
  const price = item.price?.totalPrice;
  const value = Number(price?.originalPrice || 0) / (10 ** Number(price?.currencyInfo?.decimals ?? 2));
  if (!Number.isFinite(value) || value <= 0) return []; // No permanently free games.
  const image = (item.keyImages || []).find(x => ['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail'].includes(x?.type)) || item.keyImages?.[0];
  const outputs = [];
  for (const [phase, groups] of [['active', item.promotions.promotionalOffers], ['upcoming', item.promotions.upcomingPromotionalOffers]]) {
    for (const group of groups || []) for (const promo of group?.promotionalOffers || []) {
      if (promo?.discountSetting?.discountPercentage !== 0) continue;
      const start = parseUtcTime(promo.startDate);
      const end = parseUtcTime(promo.endDate);
      if (start === null || end === null || end <= start || end <= now) continue;
      if (phase === 'active' && start > now) continue;
      if (phase === 'upcoming' && start <= now) continue;
      outputs.push({
        offer_key: `epic:${item.id}:${start}:${phase}`, source: 'epic', store: 'epic',
        kind: 'game', phase, title: plain(item.title, 180), description: plain(item.description, 700),
        image_url: safeUrl(image?.url), claim_url: epicOfferSlug(item) || 'https://store.epicgames.com/en-US/free-games',
        source_url: 'https://store.epicgames.com/en-US/free-games', original_price: value,
        currency: String(price?.currencyCode || 'USD').slice(0, 5), start_at: start, end_at: end
      });
    }
  }
  return outputs;
}
async function fetchJson(url, fetcher = fetch) {
  const res = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8500) });
  if (res.status === 201 && url.includes('gamerpower.com')) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function collectOffers(now = Date.now(), fetcher = fetch) {
  // Fetch all types so optional loot / beta filters can work too.
  const results = await Promise.allSettled([fetchJson(GAMERPOWER_ALL, fetcher), fetchJson(EPIC, fetcher)]);
  const [gamer, epic] = results;
  const offers = [];
  const warnings = [];
  if (gamer.status === 'fulfilled' && Array.isArray(gamer.value)) {
    for (const item of gamer.value.slice(0, 600)) {
      const offer = giveawayToOffer(item, now);
      if (offer) offers.push(offer);
    }
  } else warnings.push('GamerPower');
  if (epic.status === 'fulfilled') {
    const items = epic.value?.data?.Catalog?.searchStore?.elements;
    if (!Array.isArray(items)) warnings.push('Epic format');
    else for (const item of items) offers.push(...epicToOffers(item, now));
  } else warnings.push('Epic');
  if (warnings.length === 2) throw new Error('Both giveaway sources failed');
  // Prefer Epic's direct redemption link over GamerPower's link for the same Epic game.
  const normalized = x => x.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const directEpic = new Set(offers.filter(x => x.source === 'epic').map(x => x.store + ':' + x.phase + ':' + normalized(x)));
  const unique = new Map();
  for (const o of offers) {
    if (o.source === 'gamerpower' && directEpic.has(o.store + ':' + o.phase + ':' + normalized(o))) continue;
    unique.set(o.offer_key, o);
  }
  return { offers: [...unique.values()].slice(0, 600), warnings };
}
function allowedList(csv, allowed, fallback) {
  const tokens = String(csv || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  if (!tokens.length || tokens.includes('all')) return fallback;
  if (tokens.some(x => !allowed.has(x))) return null;
  return [...new Set(tokens)].join(',');
}
function matchesSetting(offer, s) {
  if (!s.enabled || (offer.phase === 'upcoming' && !s.notify_upcoming)) return false;
  if (offer.original_price < Number(s.min_price)) return false;
  if (s.stores !== 'all' && !String(s.stores).split(',').includes(offer.store)) return false;
  if (s.kinds !== 'all' && !String(s.kinds).split(',').includes(offer.kind)) return false;
  return true;
}
function money(offer) {
  const amount = Number(offer.original_price || 0);
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${offer.currency || 'USD'}`;
}
function ts(ms, type = 'f') { return ms ? `<t:${Math.floor(Number(ms) / 1000)}:${type}>` : 'Không rõ'; }
function makeEmbed(offer, theme = 'rich') {
  const isUpcoming = offer.phase === 'upcoming';
  const embed = {
    title: text(offer.title, 240), url: offer.claim_url, color: isUpcoming ? 0xF39C12 : 0x2ECC71,
    description: theme === 'rich' ? plain(offer.description || (isUpcoming ? 'Sắp được tặng miễn phí.' : 'Đang miễn phí trong thời gian giới hạn.'), 350) : undefined,
    fields: [
      { name: 'Cửa hàng', value: ({ steam: 'Steam', epic: 'Epic Games', gog: 'GOG', itch: 'itch.io', other: 'Khác' })[offer.store] || 'Khác', inline: true },
      { name: 'Giá trị gốc', value: offer.original_price > 0 ? money(offer) : 'Chưa rõ', inline: true },
      { name: isUpcoming ? 'Bắt đầu' : 'Kết thúc', value: ts(isUpcoming ? offer.start_at : offer.end_at, 'R'), inline: true }
    ],
    footer: { text: isUpcoming ? 'Sắp miễn phí • Thời gian theo cửa hàng' : 'Miễn phí có thời hạn • Có thể giới hạn khu vực' }
  };
  if (theme === 'rich' && offer.image_url) embed.image = { url: offer.image_url };
  return embed;
}
function makePost(offer, setting, preview = false) {
  const role = !preview && /^\d{17,22}$/.test(String(setting?.role_id || '')) ? String(setting.role_id) : null;
  const payload = {
    content: preview ? '🔎 **Kiểm tra thông báo game miễn phí**' : (role ? `<@&${role}>` : ''),
    embeds: [makeEmbed(offer, setting?.theme || 'rich')],
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: offer.phase === 'upcoming' ? 'Xem trên cửa hàng' : 'Nhận game miễn phí', url: offer.claim_url },
      ...(offer.source === 'gamerpower' ? [{ type: 2, style: 5, label: 'Nguồn: GamerPower', url: offer.source_url || 'https://www.gamerpower.com' }] : [])
    ] }],
    allowed_mentions: role ? { parse: [], roles: [role] } : noMentions
  };
  return payload;
}
async function discordPost(channelId, token, payload, fetcher = fetch) {
  const response = await fetcher(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
  });
  if (response.status === 429) {
    let backoff = Number(response.headers.get('Retry-After'));
    if (!Number.isFinite(backoff) || backoff <= 0) backoff = Number((await response.json().catch(() => null))?.retry_after || 60);
    const err = new Error('Discord rate limit');
    err.retryMs = Math.max(1000, Math.min(3600000, backoff * 1000));
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`Discord HTTP ${response.status}`);
    err.permanent = [400, 401, 403, 404].includes(response.status);
    throw err;
  }
  return response.json();
}

async function syncOffers(env, now = Date.now(), force = false) {
  if (!env.DB) throw new Error('D1 not configured');
  await env.DB.prepare("INSERT OR IGNORE INTO free_sync(name) VALUES ('global')").run();
  const claim = await env.DB.prepare("UPDATE free_sync SET locked_at=? WHERE name='global' AND (locked_at IS NULL OR locked_at<?) AND (?=1 OR succeeded_at IS NULL OR succeeded_at<=?)")
    .bind(now, now - 4 * 60000, force ? 1 : 0, now - POLL_MS).run();
  if (!claim.meta?.changes) return { skipped: true };
  try {
    const { offers, warnings } = await collectOffers(now);
    const statements = offers.map(o => env.DB.prepare(`INSERT INTO free_offers
      (offer_key,source,store,kind,phase,title,description,image_url,claim_url,source_url,original_price,currency,start_at,end_at,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(offer_key) DO UPDATE SET title=excluded.title, description=excluded.description,
        image_url=excluded.image_url,claim_url=excluded.claim_url,source_url=excluded.source_url,
        original_price=excluded.original_price,currency=excluded.currency,end_at=excluded.end_at,last_seen_at=excluded.last_seen_at`)
      .bind(o.offer_key,o.source,o.store,o.kind,o.phase,o.title,o.description,o.image_url,o.claim_url,o.source_url,o.original_price,o.currency,o.start_at,o.end_at,now,now));
    // D1 .batch() runs statements as a transaction. Keep batches modest.
    for (let i=0; i<statements.length; i+=60) await env.DB.batch(statements.slice(i, i + 60));
    const settings = await env.DB.prepare('SELECT * FROM free_settings WHERE enabled=1').all();
    // Consider ALL offers confirmed by the current poll, not only newly inserted rows.
    // The delivery primary key makes retries/repeated polls idempotent per guild + promotion.
    // Never backfill expired offers or an upcoming phase that has already started.
    const available = await env.DB.prepare(`SELECT * FROM free_offers WHERE last_seen_at=?
      AND ((phase='active' AND (start_at IS NULL OR start_at<=?) AND (end_at IS NULL OR end_at>?))
        OR (phase='upcoming' AND start_at>? AND (end_at IS NULL OR end_at>?)))`)
      .bind(now, now, now, now, now).all();
    let queuedCount = 0;
    for (const s of settings.results || []) {
      if (!s.bootstrapped) {
        await env.DB.prepare('UPDATE free_settings SET bootstrapped=1 WHERE guild_id=? AND bootstrapped=0').bind(s.guild_id).run();
      }
      const eligible = (available.results || []).filter(o => matchesSetting(o, s));
      if (!eligible.length) continue;
      const jobs = eligible.map(o => env.DB.prepare('INSERT OR IGNORE INTO free_deliveries(guild_id,offer_key,next_attempt_at) VALUES (?,?,?)')
        .bind(s.guild_id, o.offer_key, now));
      for (let i=0; i<jobs.length; i+=60) {
        const results = await env.DB.batch(jobs.slice(i,i+60));
        queuedCount += results.reduce((total, r) => total + (r.meta?.changes || 0), 0);
      }
    }
    await env.DB.prepare("UPDATE free_sync SET succeeded_at=?,locked_at=NULL,last_error=? WHERE name='global'")
      .bind(now, warnings.length ? warnings.join(', ') : null).run();
    // Keep notification history for the entire lifetime of a promotion, including
    // promotions lasting longer than 30 days. Otherwise the same offer is sent again.
    await env.DB.prepare(`DELETE FROM free_deliveries WHERE status IN ('sent','failed')
      AND (sent_at<? OR (sent_at IS NULL AND next_attempt_at<?))
      AND offer_key NOT IN (SELECT offer_key FROM free_offers WHERE
        (end_at IS NULL OR end_at>?) AND last_seen_at>=?)`)
      .bind(now - 30 * 86400000, now - 30 * 86400000, now, now - 14 * 86400000).run();
    await env.DB.prepare('DELETE FROM free_offers WHERE last_seen_at<? AND offer_key NOT IN (SELECT offer_key FROM free_deliveries)')
      .bind(now - 14 * 86400000).run();
    return { count: offers.length, queued: queuedCount, warnings };
  } catch (err) {
    await env.DB.prepare("UPDATE free_sync SET locked_at=NULL,last_error=? WHERE name='global'").bind(text(err?.message,180)).run();
    throw err;
  }
}
async function dispatchOffers(env, now = Date.now()) {
  if (!env.DB || !env.DISCORD_BOT_TOKEN) return 0;
  await env.DB.prepare("UPDATE free_deliveries SET status='pending' WHERE status='processing' AND locked_at<? AND attempts<6").bind(now - 5 * 60000).run();
  await env.DB.prepare("UPDATE free_deliveries SET status='failed' WHERE status='processing' AND locked_at<? AND attempts>=6").bind(now - 5 * 60000).run();
  // Expired offers are not sent even if they sat in a retry queue.
  await env.DB.prepare(`UPDATE free_deliveries SET status='failed',last_error='Offer expired'
      WHERE status='pending' AND offer_key IN (SELECT offer_key FROM free_offers WHERE (end_at IS NOT NULL AND end_at<=?) OR (phase='upcoming' AND start_at<=?))`)
    .bind(now,now).run();
  const due = await env.DB.prepare(`SELECT d.guild_id,d.offer_key,d.attempts,o.*,s.channel_id,s.role_id,s.theme,s.stores,s.kinds,s.min_price,s.notify_upcoming,s.enabled
      FROM free_deliveries d JOIN free_offers o ON o.offer_key=d.offer_key
      JOIN free_settings s ON s.guild_id=d.guild_id
      WHERE d.status='pending' AND d.next_attempt_at<=? AND s.enabled=1 ORDER BY d.next_attempt_at LIMIT ?`)
    .bind(now,MAX_POSTS_PER_TICK).all();
  let sent = 0;
  for (const row of due.results || []) {
    if (!matchesSetting(row,row)) {
      await env.DB.prepare("UPDATE free_deliveries SET status='failed',last_error='Excluded by current filter' WHERE guild_id=? AND offer_key=? AND status='pending'")
        .bind(row.guild_id,row.offer_key).run();
      continue;
    }
    const claim = await env.DB.prepare("UPDATE free_deliveries SET status='processing',attempts=attempts+1,locked_at=? WHERE guild_id=? AND offer_key=? AND status='pending'")
      .bind(now,row.guild_id,row.offer_key).run();
    if (!claim.meta?.changes) continue;
    try {
      await discordPost(row.channel_id, env.DISCORD_BOT_TOKEN, makePost(row,row));
      await env.DB.prepare("UPDATE free_deliveries SET status='sent',sent_at=?,last_error=NULL,locked_at=NULL WHERE guild_id=? AND offer_key=?")
        .bind(now,row.guild_id,row.offer_key).run();
      sent++;
    } catch (err) {
      const failed = err.permanent || row.attempts + 1 >= 6;
      const delay = err.retryMs || Math.min(3600000, 60000 * (2 ** (row.attempts + 1)));
      await env.DB.prepare('UPDATE free_deliveries SET status=?,next_attempt_at=?,locked_at=NULL,last_error=? WHERE guild_id=? AND offer_key=?')
        .bind(failed ? 'failed' : 'pending', now + delay, text(err.message,160),row.guild_id,row.offer_key).run();
      console.warn('Free game notification delivery failed:', row.guild_id, err.message);
    }
  }
  return sent;
}
async function freeCron(env, now = Date.now()) {
  if (!env.DB || !env.DISCORD_BOT_TOKEN) return;
  try { await syncOffers(env,now); } catch (e) { console.warn('Free game feed error:',e?.message); }
  try { await dispatchOffers(env,now); } catch (e) { console.error('Free game dispatch error:',e); }
}

function getOpt(interaction, name) { return interaction.data?.options?.[0]?.options?.find(o => o.name === name)?.value; }
function action(interaction) { return interaction.data?.options?.[0]?.name || 'help'; }
function userId(interaction) { return interaction.member?.user?.id || interaction.user?.id || ''; }
function isManager(interaction) {
  try { return (BigInt(interaction.member?.permissions || '0') & 0x28n) !== 0n; }
  catch { return false; }
}
function interactionReply(message, data = {}) {
  return { content: message, embeds: [], components: [], allowed_mentions: noMentions, ...data };
}
function listButtons(phase,store,offset,owner,total) {
  return [{ type: 1, components: [
    { type: 2, style: 2, label: 'Trước', custom_id: `free:page:${phase}:${store}:${Math.max(0,offset-4)}:${owner}`, disabled: offset === 0 },
    { type: 2, style: 2, label: 'Sau', custom_id: `free:page:${phase}:${store}:${offset+4}:${owner}`, disabled: offset + 4 >= total }
  ] }];
}
async function listOffers(env, phase, store, offset, owner, query = '') {
  const now = Date.now();
  const rows = await env.DB.prepare('SELECT * FROM free_offers WHERE phase=? AND (end_at IS NULL OR end_at>?) AND last_seen_at>=? ORDER BY COALESCE(end_at,9999999999999) ASC LIMIT 400')
    .bind(phase,now,now-FRESH_MS).all();
  const needle = query.trim().toLowerCase();
  const filtered = (rows.results || []).filter(o => (store==='all' || o.store===store) && (!needle || o.title.toLowerCase().includes(needle)));
  const items = filtered.slice(offset,offset+4);
  if (!items.length) return interactionReply('Chưa tìm thấy game phù hợp. Dùng `/free refresh` (quản trị viên) để cập nhật dữ liệu, hoặc thử lại sau.');
  return interactionReply(`**${phase==='active'?'Game đang miễn phí':'Game sắp miễn phí'}** • ${filtered.length} kết quả • Trang ${Math.floor(offset/4)+1}/${Math.ceil(filtered.length/4)}`, {
    embeds: items.map(x => makeEmbed(x,'compact')),
    components: [
      ...items.map(x=>({ type:1, components:[{ type:2, style:5, label:`Nhận / Xem: ${text(x.title,62)}`, url:x.claim_url }] })),
      ...(needle ? [] : listButtons(phase,store,offset,owner,filtered.length))
    ]
  });
}
function settingStatus(s) {
  if (!s) return 'Chưa cấu hình. Quản trị viên dùng `/free setup channel:`.';
  return `**Free Games ${s.enabled ? 'đang bật' : 'đã tắt'}**\n`+
    `Kênh: <#${s.channel_id}>\n`+
    `Role thông báo: ${s.role_id ? `<@&${s.role_id}>` : 'Không ping'}\n`+
    `Cửa hàng: \`${s.stores}\` • Loại: \`${s.kinds}\`\n`+
    `Giá gốc tối thiểu: \`${Number(s.min_price)}\` • Sắp miễn phí: **${s.notify_upcoming ? 'Bật' : 'Tắt'}**\n`+
    `Giao diện: \`${s.theme}\` • Đã khởi tạo dữ liệu: **${s.bootstrapped ? 'Có' : 'Chưa'}**`;
}
function helpText() {
  return '**Free Games — săn game miễn phí tự động**\n' +
    '`/free now` • Game đang miễn phí, có thể lọc cửa hàng.\n' +
    '`/free upcoming` • Lịch game sắp miễn phí (Epic).\n' +
    '`/free search query:` • Tìm game trong danh sách.\n' +
    '`/free status` • Xem cấu hình server.\n' +
    '**Quản trị viên (Manage Server):**\n' +
    '`/free setup channel: [role:]` • Chọn kênh thông báo.\n' +
    '`/free filter stores: kinds: min_price: upcoming:` • Bộ lọc.\n' +
    '`/free theme style:` • Giao diện rich/compact.\n' +
    '`/free mention role: [clear:]` • Role sẽ ping (hoặc bỏ ping).\n' +
    '`/free toggle enabled:` • Bật/tắt.\n' +
    '`/free test` • Gửi thông báo mẫu, không ping.\n' +
    '`/free refresh` • Kiểm tra nguồn ngay.\n' +
    'Mặc định chỉ báo **game có giá gốc > 0**, giảm còn miễn phí có thời hạn.';
}
async function runCommand(interaction, env, edit) {
  const cmd = action(interaction);
  if (!env.DB) return edit(interaction,interactionReply('Chưa liên kết D1. Hãy chạy `free-games.sql` và kiểm tra binding DB.'));
  const guild = interaction.guild_id;
  let existing;
  try {
    if (!guild) return edit(interaction,interactionReply('Lệnh chỉ hỗ trợ trong server.'));
    existing = await env.DB.prepare('SELECT * FROM free_settings WHERE guild_id=?').bind(guild).first();
    if (cmd === 'help') return edit(interaction,interactionReply(helpText()));
    if (cmd === 'status') return edit(interaction,interactionReply(settingStatus(existing)));
    if (['now','upcoming','search'].includes(cmd)) {
      let store = String(getOpt(interaction,'store') || 'all');
      if (!STORES.has(store)) store = 'all';
      const query = cmd==='search' ? text(getOpt(interaction,'query'),100) : '';
      const phase = cmd === 'upcoming' ? 'upcoming':'active';
      let result = await listOffers(env,phase,store,0,userId(interaction),query);
      if (result.embeds.length === 0) {
        // First run before any cron: read live feeds directly, but don't send alerts.
        const state = await env.DB.prepare("SELECT succeeded_at FROM free_sync WHERE name='global'").first();
        if (!state?.succeeded_at) {
          await syncOffers(env,Date.now(),true);
          result = await listOffers(env,phase,store,0,userId(interaction),query);
        }
      }
      return edit(interaction,result);
    }
    if (!isManager(interaction)) return edit(interaction,interactionReply('Chỉ thành viên có quyền **Manage Server** mới được thay đổi thông báo.'));
    if (cmd==='setup') {
      const channel = String(getOpt(interaction,'channel') || '');
      const role = getOpt(interaction,'role');
      if (!/^\d{17,22}$/.test(channel)) return edit(interaction,interactionReply('Chọn kênh văn bản hợp lệ.'));
      if (!env.DISCORD_BOT_TOKEN) return edit(interaction,interactionReply('Thiếu Discord Bot Token.'));
      const now = Date.now();
      await env.DB.prepare(`INSERT INTO free_settings(guild_id,channel_id,role_id,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,role_id=COALESCE(excluded.role_id,free_settings.role_id),enabled=1,updated_at=excluded.updated_at`)
        .bind(guild,channel,role?String(role):null,now).run();
      return edit(interaction,interactionReply('Đã chọn kênh thông báo. Bot sẽ thông báo các **ưu đãi đang còn hiệu lực và chưa từng gửi** kể từ lần đồng bộ kế tiếp. Dùng `/free test` để kiểm tra quyền gửi tin.'));
    }
    if (!existing) return edit(interaction,interactionReply('Hãy chạy `/free setup` trước.'));
    if (cmd==='filter') {
      const stores = getOpt(interaction,'stores') === undefined ? existing.stores : allowedList(getOpt(interaction,'stores'),STORES,'all');
      const kinds = getOpt(interaction,'kinds') === undefined ? existing.kinds : allowedList(getOpt(interaction,'kinds'),KINDS,'all');
      const price = getOpt(interaction,'min_price') ?? existing.min_price;
      const upcoming = getOpt(interaction,'upcoming') === undefined ? existing.notify_upcoming : (getOpt(interaction,'upcoming')?1:0);
      if (!stores || !kinds || !Number.isFinite(Number(price)) || Number(price)<0 || Number(price)>10000)
        return edit(interaction,interactionReply('Bộ lọc không hợp lệ. Cửa hàng: `steam,epic,gog,itch,other,all`; loại: `game,loot,beta,all`; giá: 0–10000.'));
      await env.DB.prepare('UPDATE free_settings SET stores=?,kinds=?,min_price=?,notify_upcoming=?,updated_at=? WHERE guild_id=?')
        .bind(stores,kinds,Number(price),upcoming,Date.now(),guild).run();
      return edit(interaction,interactionReply('Đã cập nhật bộ lọc. Lọc mới áp dụng từ lần đồng bộ kế tiếp, kể cả ưu đãi đang còn hiệu lực nhưng chưa từng gửi.'));
    }
    if (cmd==='theme') {
      const theme = getOpt(interaction,'style');
      if (!['rich','compact'].includes(theme)) return edit(interaction,interactionReply('Chọn `rich` hoặc `compact`.'));
      await env.DB.prepare('UPDATE free_settings SET theme=? WHERE guild_id=?').bind(theme,guild).run();
      return edit(interaction,interactionReply(`Đã đổi giao diện thông báo sang \`${theme}\`.`));
    }
    if (cmd==='mention') {
      const clear = getOpt(interaction,'clear') === true;
      const role = getOpt(interaction,'role');
      if (!clear && !/^\d{17,22}$/.test(String(role || ''))) return edit(interaction,interactionReply('Chọn role, hoặc bật `clear` để không ping.'));
      await env.DB.prepare('UPDATE free_settings SET role_id=? WHERE guild_id=?').bind(clear?null:String(role),guild).run();
      return edit(interaction,interactionReply(clear?'Đã tắt ping role.':'Đã chọn role thông báo.'));
    }
    if (cmd==='toggle') {
      const enabled = getOpt(interaction,'enabled');
      if (typeof enabled !== 'boolean') return edit(interaction,interactionReply('Chọn trạng thái bật hoặc tắt.'));
      await env.DB.prepare('UPDATE free_settings SET enabled=?,updated_at=? WHERE guild_id=?').bind(enabled?1:0,Date.now(),guild).run();
      if (!enabled) await env.DB.prepare("UPDATE free_deliveries SET status='failed',last_error='Disabled by administrator' WHERE guild_id=? AND status='pending'").bind(guild).run();
      return edit(interaction,interactionReply(enabled?'Đã bật thông báo.':'Đã tắt thông báo.'));
    }
    if (cmd==='test') {
      if (!env.DISCORD_BOT_TOKEN) return edit(interaction,interactionReply('Bot Token chưa được cấu hình.'));
      const now = Date.now();
      const row = await env.DB.prepare("SELECT * FROM free_offers WHERE phase='active' AND (end_at IS NULL OR end_at>?) AND last_seen_at>? ORDER BY first_seen_at DESC LIMIT 1")
        .bind(now,now-FRESH_MS).first();
      const testOffer = row || { title: 'Đây là thông báo thử nghiệm',description:'Nếu bạn thấy tin này, bot đã có quyền gửi thông báo.',store:'epic',phase:'active',original_price:10,currency:'USD',end_at:now+86400000,claim_url:'https://store.epicgames.com/en-US/free-games',source:'epic' };
      await discordPost(existing.channel_id,env.DISCORD_BOT_TOKEN,makePost(testOffer,existing,true));
      return edit(interaction,interactionReply(`Đã gửi tin thử nghiệm vào <#${existing.channel_id}> (không ping role).`));
    }
    if (cmd==='refresh') {
      const sync = await syncOffers(env,Date.now(),true);
      return edit(interaction,interactionReply(sync.skipped ? 'Đồng bộ đang chạy ở một phiên khác.' : `Đã cập nhật ${sync.count} ưu đãi. ${sync.warnings.length ? `Nguồn tạm lỗi: ${sync.warnings.join(', ')}.` : ''}`));
    }
    return edit(interaction,interactionReply(helpText()));
  } catch (err) {
    console.error('Free games command:',cmd,err);
    return edit(interaction,interactionReply('Không thể xử lý. Kiểm tra D1 schema, Bot Token và kết nối nguồn game.'));
  }
}
function freeCommand(interaction, env, ctx, edit) {
  if (!interaction.guild_id) return Response.json({ type: 4, data: { content:'Lệnh chỉ hỗ trợ trong server.',flags:64,allowed_mentions:noMentions } });
  ctx.waitUntil(runCommand(interaction,env,edit).catch(e => console.error('Free command reply error:',e)));
  return Response.json({ type: 5, data: { flags: 64 } });
}
function freeButton(interaction, env, ctx, edit) {
  const match = String(interaction.data?.custom_id || '').match(/^free:page:(active|upcoming):(all|steam|epic|gog|itch|other):(\d{1,3}):(\d{17,22})$/);
  if (!match) return Response.json({ type: 4, data: { content:'Nút không hợp lệ.',flags:64 } });
  if (match[4] !== userId(interaction)) return Response.json({ type: 4, data: { content:'Chỉ người mở danh sách mới có thể chuyển trang.',flags:64 } });
  ctx.waitUntil(listOffers(env,match[1],match[2],Number(match[3]),match[4]).then(payload=>edit(interaction,payload)).catch(e=>console.error('Free page:',e)));
  return Response.json({ type:6 });
}
export { freeCommand, freeButton, freeCron };
export const __freeTest = { collectOffers, giveawayToOffer, epicToOffers, parseUtcTime, priceNumber, matchesSetting, allowedList, makePost, makeEmbed, listOffers, syncOffers, dispatchOffers, isManager, runCommand };

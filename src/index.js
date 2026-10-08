/**
 * Discord Steam + reminders bot for Cloudflare Workers.
 * No Gateway connection, external npm runtime dependency, or server required.
 * Secrets: DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN.
 * Binding: DB (Cloudflare D1); cron: * * * * *.
 */

const API = 'https://discord.com/api/v10';
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const STEAM_PAGES = ['Tổng quan', 'Mô tả', 'Cấu hình', 'Khác'];
const EMPTY_MENTIONS = { parse: [] };

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function reply(content, ephemeral = false, extra = {}) {
  return json({ type: 4, data: { content, allowed_mentions: EMPTY_MENTIONS,
    ...(ephemeral ? { flags: 64 } : {}), ...extra } });
}

function clamp(value, maximum = 1000) {
  const str = String(value == null ? '' : value).trim();
  if (str.length <= maximum) return str;
  return str.slice(0, maximum - 3) + '...';
}

function removeHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_s, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_s, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}

function safeHttps(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

function field(name, value, inline = false, limit = 1024) {
  return { name: clamp(name, 256), value: clamp(value || 'Không có dữ liệu', limit) || 'Không có dữ liệu', inline };
}

function snowflakeDate(id) {
  try { return Number((BigInt(id) >> 22n) + 1420070400000n); }
  catch { return null; }
}

function discordTime(millis, format = 'F') {
  return Number.isFinite(millis) ? `<t:${Math.floor(millis / 1000)}:${format}>` : 'Không rõ';
}

function option(interaction, name) {
  return interaction.data?.options?.find(x => x.name === name);
}

function suboption(interaction, name) {
  return interaction.data?.options?.[0]?.options?.find(x => x.name === name);
}

function requestUserId(interaction) {
  return interaction.member?.user?.id || interaction.user?.id;
}

function bytes(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) throw Error('invalid hex');
  return Uint8Array.from(hex.match(/../g), x => parseInt(x, 16));
}

async function verifyRequest(request, raw, publicKey) {
  const sig = request.headers.get('X-Signature-Ed25519');
  const stamp = request.headers.get('X-Signature-Timestamp');
  if (!sig || !stamp || !publicKey || !/^\d{10}$/.test(stamp)) return false;
  if (Math.abs(Date.now() - Number(stamp) * 1000) > 5 * 60 * 1000) return false;
  try {
    const key = await crypto.subtle.importKey('raw', bytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bytes(sig), new TextEncoder().encode(stamp + raw));
  } catch { return false; }
}

async function cachedJson(url, seconds, timeoutMs = 5000) {
  const req = new Request(url);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(req);
    if (hit) return hit.json();
  }
  const response = await fetch(url, { headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw Error(`Upstream HTTP ${response.status}`);
  const data = await response.json();
  if (cache) {
    // Cache our JSON, never blindly cache headers such as Set-Cookie from Steam.
    const copy = new Response(JSON.stringify(data), { headers: {
      'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${seconds}` } });
    try { await cache.put(req, copy); } catch (err) { console.warn('Cache write:', err?.message); }
  }
  return data;
}

async function searchSteam(term, quick = false) {
  const q = clamp(term, 100);
  if (q.length < 2) return [];
  const countries = quick ? ['us'] : ['vn', 'us'];
  for (const cc of countries) {
    try {
      const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=${cc}`;
      const data = await cachedJson(url, 180, quick ? 1900 : 5500);
      const items = (Array.isArray(data.items) ? data.items : [])
        .filter(x => x.type === 'app' && Number.isSafeInteger(x.id) && x.id > 0)
        .map(x => ({ id: x.id, name: clamp(removeHtml(x.name), 92) }));
      if (items.length || cc === 'us') return items.slice(0, 10);
    } catch (e) {
      console.warn('Steam search failed:', e?.message);
    }
  }
  return [];
}

async function getSteamApp(appid) {
  if (!/^\d{1,10}$/.test(String(appid)) || Number(appid) <= 0) return null;
  for (const [cc, lang] of [['vn', 'vietnamese'], ['us', 'english']]) {
    try {
      const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=${lang}`;
      const data = await cachedJson(url, 1800, 6500);
      if (data?.[appid]?.success && data[appid].data) return data[appid].data;
    } catch (e) { console.warn('Steam details failed:', e?.message); }
  }
  return null;
}

function extractAppId(text) {
  const value = String(text || '').trim();
  const url = value.match(/(?:store\.steampowered\.com\/app\/)(\d{1,10})/i);
  if (url) return url[1];
  return /^\d{1,10}$/.test(value) && Number(value) > 0 ? value : null;
}

function steamButtons(appid, page, owner) {
  const nav = STEAM_PAGES.map((title, index) => ({
    type: 2, style: index === page ? 3 : 2,
    label: title, custom_id: `steam:page:${appid}:${index}:${owner}`,
    disabled: index === page
  }));
  return [
    { type: 1, components: nav },
    { type: 1, components: [
      { type: 2, style: 5, label: 'Steam Store', url: `https://store.steampowered.com/app/${appid}/` },
      { type: 2, style: 5, label: 'SteamDB', url: `https://steamdb.info/app/${appid}/` }
    ] }
  ];
}

function makeSteamPage(app, appid, page, owner, extras = {}) {
  const id = Number(app.steam_appid || appid);
  const e = {
    title: clamp(app.name || `Steam App ${appid}`, 256),
    url: `https://store.steampowered.com/app/${appid}/`, color: 0x1b2838,
    thumbnail: safeHttps(app.header_image) ? { url: app.header_image } : undefined,
    footer: { text: `Steam AppID: ${appid} | Trang ${page + 1}/${STEAM_PAGES.length}` },
    fields: []
  };
  const add = (name, value, inline, limit) => e.fields.push(field(name, value, inline, limit));
  if (page === 0) {
    e.description = clamp(removeHtml(app.short_description || app.about_the_game) || 'Không có mô tả.', 1100);
    const price = app.is_free ? 'Free to Play' :
      app.price_overview?.final_formatted || app.price_overview?.initial_formatted || 'Chưa công bố';
    const discount = Number(app.price_overview?.discount_percent || 0);
    add('Giá', discount > 0 ? `${price} (-${discount}%)` : price, true);
    add('Ngày phát hành', `${app.release_date?.date || 'Chưa rõ'}${app.release_date?.coming_soon ? ' (sắp ra)' : ''}`, true);
    add('Thể loại', (app.genres || []).map(x => x.description).join(', '), false, 700);
    add('Nhà phát triển', (app.developers || []).join(', '), true);
    add('Nhà phát hành', (app.publishers || []).join(', '), true);
    add('Nền tảng', Object.entries(app.platforms || {}).filter(([, ok]) => ok).map(([p]) => p).join(', '), true);
    add('Đánh giá', [
      app.metacritic?.score ? `Metacritic: ${app.metacritic.score}/100` : null,
      app.recommendations?.total ? `Lượt đề xuất Steam: ${app.recommendations.total.toLocaleString('en-US')}` : null
    ].filter(Boolean).join(' | ') || 'Chưa có', false);
    if (extras.reviews?.total_reviews) {
      const r = extras.reviews;
      const positive = Math.round(100 * r.total_positive / Math.max(1, r.total_reviews));
      add('Đánh giá người chơi Steam', `${r.review_score_desc || 'Reviews'} | ${positive}% tích cực / ${Number(r.total_reviews).toLocaleString('en-US')} lượt`, false);
    }
    if (Number.isSafeInteger(extras.players)) add('Đang chơi trên Steam', `${extras.players.toLocaleString('en-US')} người`, true);
    add('Tính năng', (app.categories || []).map(x => x.description).join(', '), false, 850);
    if (safeHttps(app.website)) add('Website', app.website, false, 900);
  } else if (page === 1) {
    e.description = clamp(removeHtml(app.about_the_game || app.detailed_description || app.short_description), 3700) || 'Không có mô tả.';
    const screens = (app.screenshots || []).slice(0, 5);
    if (screens[0]?.path_full && safeHttps(screens[0].path_full)) e.image = { url: screens[0].path_full };
    if (screens.length) add('Ảnh chụp màn hình', screens.map((s, i) =>
      `[Ảnh ${i + 1}](${safeHttps(s.path_full) || `https://store.steampowered.com/app/${appid}/`})`).join(' | '));
    const movies = (app.movies || []).slice(0, 3).map(x => {
      const link = safeHttps(x.mp4?.max || x.webm?.max);
      return link ? `[${clamp(x.name, 45)}](${link})` : null;
    }).filter(Boolean);
    if (movies.length) add('Trailer', movies.join(' | '));
  } else if (page === 2) {
    e.description = 'Yêu cầu cấu hình (theo Steam, nếu nhà phát hành cung cấp).';
    for (const [platform, reqKey] of [['Windows', 'pc_requirements'], ['macOS', 'mac_requirements'], ['Linux', 'linux_requirements']]) {
      const requirements = app[reqKey] || {};
      add(`${platform} - Tối thiểu`, removeHtml(requirements.minimum || 'Không có dữ liệu'), false, 850);
      if (requirements.recommended) add(`${platform} - Đề nghị`, removeHtml(requirements.recommended), false, 850);
    }
  } else {
    e.description = 'Thông tin bổ sung do Steam Store cung cấp.';
    add('Ngôn ngữ', removeHtml(app.supported_languages), false, 750);
    add('Độ tuổi tối thiểu', String(app.required_age ?? 'Không rõ'), true);
    add('Thành tựu', String(app.achievements?.total ?? 'Không có'), true);
    add('Loại ứng dụng', String(app.type || 'game'), true);
    add('Hỗ trợ', [app.support_info?.url, app.support_info?.email].filter(Boolean).join('\n'), false);
    const dlcs = (app.dlc || []).slice(0, 12).map(id => `[${id}](https://store.steampowered.com/app/${id}/)`);
    if (dlcs.length) add(`DLC (${app.dlc.length})`, dlcs.join(' | '), false, 950);
    if (app.legal_notice) add('Pháp lý', removeHtml(app.legal_notice), false, 550);
    if (app.controller_support) add('Tay cầm', app.controller_support, true);
  }
  return { embeds: [e], components: steamButtons(appid, page, owner), allowed_mentions: EMPTY_MENTIONS };
}

async function discordRequest(path, token, method = 'GET', payload) {
  if (!token) throw Error('DISCORD_BOT_TOKEN chua duoc cau hinh');
  const response = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw Error(`Discord API ${response.status}: ${clamp(detail, 180)}`);
  }
  return response.status === 204 ? null : response.json();
}

async function editOriginal(interaction, payload) {
  const url = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const response = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error(`Edit response HTTP ${response.status}`);
}

async function finishSteam(interaction, query, env) {
  try {
    const owner = requestUserId(interaction);
    let appid = extractAppId(query);
    if (!appid) {
      const matches = await searchSteam(query);
      if (!matches.length) {
        await editOriginal(interaction, { content: `Không tìm thấy game với từ khóa **${clamp(query, 80)}**.`, components: [] });
        return;
      }
      const exact = matches.find(x => x.name.toLocaleLowerCase() === query.trim().toLocaleLowerCase());
      if (exact) appid = String(exact.id);
      else {
        await editOriginal(interaction, {
          content: `Tìm thấy ${matches.length} kết quả cho **${clamp(query, 70)}**. Chọn game bên dưới:`,
          components: [{ type: 1, components: [{ type: 3, custom_id: `steam:pick:${owner}`,
            placeholder: 'Chọn game Steam', min_values: 1, max_values: 1,
            options: matches.map(x => ({ label: clamp(x.name, 100), value: String(x.id),
              description: `AppID ${x.id}` })) }] }], embeds: [], allowed_mentions: EMPTY_MENTIONS
        });
        return;
      }
    }
    await showSteam(interaction, appid, 0, owner);
  } catch (error) {
    console.error('Steam command error:', error);
    try { await editOriginal(interaction, { content: 'Không tải được dữ liệu Steam. Thử lại sau.', embeds: [], components: [] }); }
    catch (e) { console.error('Discord edit error:', e); }
  }
}

async function getSteamExtras(appid) {
  const [reviews, players] = await Promise.all([
    cachedJson(`https://store.steampowered.com/appreviews/${appid}?json=1&filter=all&language=all&num_per_page=1`, 900, 3000)
      .then(x => x.query_summary || null).catch(() => null),
    cachedJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`, 300, 3000)
      .then(x => x.response?.result === 1 ? x.response.player_count : null).catch(() => null)
  ]);
  return { reviews, players };
}

async function showSteam(interaction, appid, page, owner) {
  const [app, extras] = await Promise.all([
    getSteamApp(appid), page === 0 ? getSteamExtras(appid) : Promise.resolve({})
  ]);
  if (!app) {
    await editOriginal(interaction, { content: `Không tìm thấy AppID ${appid}, hoặc Steam đang không phản hồi.`, embeds: [], components: [] });
    return;
  }
  await editOriginal(interaction, { content: '', ...makeSteamPage(app, appid, page, owner, extras) });
}

async function handleAutocomplete(interaction) {
  if (interaction.data?.name !== 'steam') return json({ type: 8, data: { choices: [] } });
  const focused = interaction.data?.options?.find(x => x.focused);
  if (!focused || focused.name !== 'query') return json({ type: 8, data: { choices: [] } });
  const query = String(focused.value || '').trim();
  const appid = extractAppId(query);
  if (appid) return json({ type: 8, data: { choices: [
    { name: `Tra cứu AppID ${appid}`, value: appid }
  ] } });
  let results = [];
  try { results = await searchSteam(query, true); } catch (e) { console.warn('Autocomplete:', e); }
  return json({ type: 8, data: { choices: results.map(x => ({
    name: clamp(`${x.name} (AppID: ${x.id})`, 100), value: String(x.id)
  })) } });
}

function avatarUrl(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=1024`;
  const fallback = user.discriminator && user.discriminator !== '0'
    ? Number(user.discriminator) % 5 : Number(BigInt(user.id) >> 22n) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${fallback}.png`;
}

function memberAvatarUrl(guild, userId, member) {
  if (!guild || !member?.avatar) return null;
  return `https://cdn.discordapp.com/guilds/${guild}/users/${userId}/avatars/${member.avatar}.${member.avatar.startsWith('a_') ? 'gif' : 'png'}?size=1024`;
}

async function userInfo(interaction, env) {
  const selectedId = String(option(interaction, 'user')?.value || requestUserId(interaction));
  const partial = interaction.data?.resolved || {};
  let user = partial.users?.[selectedId] || (selectedId === requestUserId(interaction) ?
    interaction.member?.user || interaction.user : null);
  let member = partial.members?.[selectedId] || (selectedId === requestUserId(interaction) ? interaction.member : null);
  try {
    if (!user) user = await discordRequest(`/users/${selectedId}`, env.DISCORD_BOT_TOKEN);
    // The Discord user endpoint can include the banner missing from resolved user objects.
    const [fullUser, fullMember] = await Promise.all([
      discordRequest(`/users/${selectedId}`, env.DISCORD_BOT_TOKEN).catch(() => user),
      discordRequest(`/guilds/${interaction.guild_id}/members/${selectedId}`, env.DISCORD_BOT_TOKEN).catch(() => member)
    ]);
    user = fullUser || user;
    member = fullMember || member;
  } catch (e) { console.warn('Discord user lookup:', e?.message); }
  if (!user) return { content: 'Không đọc được thông tin người dùng. Kiểm tra Bot Token.' };
  const av = avatarUrl(user);
  const serverAv = memberAvatarUrl(interaction.guild_id, user.id, member);
  const banner = user.banner ? `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${user.banner.startsWith('a_') ? 'gif' : 'png'}?size=1024` : null;
  const isAvatar = interaction.data?.name === 'avatar';
  const e = { title: isAvatar ? `Avatar: ${user.global_name || user.username}` : `Thành viên: ${user.global_name || user.username}`,
    color: user.accent_color || 0x5865f2,
    thumbnail: isAvatar ? undefined : { url: serverAv || av },
    image: isAvatar ? { url: serverAv || av } : (banner ? { url: banner } : undefined),
    fields: []
  };
  const buttons = [{ type: 2, style: 5, label: 'Avatar', url: av }];
  if (serverAv) buttons.push({ type: 2, style: 5, label: 'Server Avatar', url: serverAv });
  if (banner) buttons.push({ type: 2, style: 5, label: 'Banner', url: banner });
  if (!isAvatar) {
    e.fields.push(field('Tên tài khoản', user.username, true));
    e.fields.push(field('Tên hiển thị', member?.nick || user.global_name || user.username, true));
    e.fields.push(field('Discord ID', user.id, false));
    e.fields.push(field('Tạo tài khoản', discordTime(snowflakeDate(user.id)), true));
    e.fields.push(field('Vào server', member?.joined_at ? discordTime(Date.parse(member.joined_at)) : 'Không rõ', true));
    if (member?.premium_since) e.fields.push(field('Boost server', discordTime(Date.parse(member.premium_since)), true));
    if (Array.isArray(member?.roles) && member.roles.length) {
      let roles = member.roles.map(x => `<@&${x}>`);
      try {
        const data = await discordRequest(`/guilds/${interaction.guild_id}/roles`, env.DISCORD_BOT_TOKEN);
        const byId = new Map(data.map(x => [x.id, x]));
        roles = member.roles.map(id => byId.get(id)).filter(Boolean).sort((a, b) => b.position - a.position)
          .map(x => x.name);
      } catch (e) { console.warn('Roles lookup:', e?.message); }
      e.fields.push(field(`Roles (${member.roles.length})`, roles.join(', '), false, 900));
    }
  }
  return { embeds: [e], components: [{ type: 1, components: buttons }], allowed_mentions: EMPTY_MENTIONS };
}

/** Parse relative time 15m, 2h, 1d, 1w or Vietnam civil datetime. */
function parseWhen(text, now = Date.now()) {
  const input = String(text || '').trim();
  const rel = input.match(/^(\d{1,4})\s*([mhdw])$/i);
  if (rel) {
    const unit = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[rel[2].toLowerCase()];
    return now + Number(rel[1]) * unit;
  }
  const parts = input.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (parts) {
    const [y, m, d, h, min] = parts.slice(1).map(Number);
    const localDate = new Date(Date.UTC(y, m - 1, d, h, min));
    if (localDate.getUTCFullYear() !== y || localDate.getUTCMonth() !== m - 1 ||
      localDate.getUTCDate() !== d || localDate.getUTCHours() !== h || localDate.getUTCMinutes() !== min) return null;
    return localDate.getTime() - VN_OFFSET_MS;
  }
  // RFC3339 with a mandatory explicit timezone is safe; no implicit host locale.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) {
    const time = Date.parse(input);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

async function reminderCommand(interaction, env) {
  if (!interaction.guild_id || !interaction.channel_id) return reply('Lệnh nhắc nhở chỉ dùng trong server.', true);
  if (!env.DB) return reply('Thiếu D1 binding DB. Hãy kết nối database với Worker.', true);
  const owner = requestUserId(interaction);
  const action = interaction.data?.options?.[0]?.name;
  try {
    if (action === 'create') {
      const title = String(suboption(interaction, 'event')?.value || '').trim();
      const when = String(suboption(interaction, 'when')?.value || '').trim();
      const dueAt = parseWhen(when);
      const channel = String(suboption(interaction, 'channel')?.value || interaction.channel_id);
      const now = Date.now();
      if (!title || title.length > 180 || /[\r\n]/.test(title)) return reply('Tên sự kiện phải dài 1-180 ký tự và trên một dòng.', true);
      if (dueAt == null) return reply('Thời gian không hợp lệ. Dùng `15m`, `2h`, `1d` hoặc `2026-10-12 20:30` (giờ Việt Nam).', true);
      if (dueAt < now + 60000 || dueAt > now + 365 * 86400000) return reply('Chọn từ 1 phút đến 365 ngày kể từ bây giờ.', true);
      const existing = await env.DB.prepare("SELECT COUNT(*) AS total FROM reminders WHERE guild_id=? AND user_id=? AND status IN ('pending','processing')")
        .bind(interaction.guild_id, owner).first();
      if ((existing?.total || 0) >= 25) return reply('Bạn chỉ được đặt tối đa 25 nhắc nhở đang hoạt động.', true);
      const inserted = await env.DB.prepare('INSERT INTO reminders (guild_id,user_id,channel_id,title,due_at,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(interaction.guild_id, owner, channel, title, dueAt, dueAt, now).run();
      return reply(`Đã tạo nhắc nhở **#${inserted.meta.last_row_id}**: **${clamp(title, 180)}**\n` +
        `Thời gian: ${discordTime(dueAt)} (${discordTime(dueAt, 'R')})\nKênh: <#${channel}>`, true);
    }
    if (action === 'list') {
      const data = await env.DB.prepare("SELECT id,title,due_at,status FROM reminders WHERE guild_id=? AND user_id=? AND status IN ('pending','processing','failed') ORDER BY due_at LIMIT 25")
        .bind(interaction.guild_id, owner).all();
      const reminders = data.results || [];
      if (!reminders.length) return reply('Bạn không có nhắc nhở nào đang chờ.', true);
      return reply('**Các nhắc nhở của bạn:**\n' + reminders.map(r =>
        `#${r.id} - **${clamp(r.title, 70)}** - ${discordTime(r.due_at)}${r.status === 'failed' ? ' (gửi thất bại)' : ''}`).join('\n'), true);
    }
    if (action === 'cancel') {
      const id = Number(suboption(interaction, 'id')?.value);
      if (!Number.isSafeInteger(id) || id < 1) return reply('ID nhắc nhở không hợp lệ.', true);
      const result = await env.DB.prepare("DELETE FROM reminders WHERE id=? AND user_id=? AND guild_id=? AND status IN ('pending','failed')")
        .bind(id, owner, interaction.guild_id).run();
      return reply(result.meta.changes ? `Đã hủy nhắc nhở #${id}.` : 'Không tìm thấy nhắc nhở của bạn, hoặc nó đang được gửi.', true);
    }
    return reply('Dùng `/remind create`, `/remind list`, `/remind cancel`.', true);
  } catch (error) {
    console.error('D1 reminder error:', error);
    return reply('Lỗi database. Kiểm tra D1 binding DB và schema.sql.', true);
  }
}

async function processReminders(env, clock = Date.now()) {
  if (!env.DB || !env.DISCORD_BOT_TOKEN) throw Error('DB or bot token not configured');
  // Recover stuck sends; claiming below minimizes duplicate delivery from concurrent cron runs.
  await env.DB.prepare("UPDATE reminders SET status='pending' WHERE status='processing' AND locked_at < ? AND attempts < 5")
    .bind(clock - 10 * 60000).run();
  await env.DB.prepare("UPDATE reminders SET status='failed' WHERE status='processing' AND locked_at < ? AND attempts >= 5")
    .bind(clock - 10 * 60000).run();
  const due = await env.DB.prepare("SELECT * FROM reminders WHERE status='pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20")
    .bind(clock).all();
  for (const r of due.results || []) {
    const claimed = await env.DB.prepare("UPDATE reminders SET status='processing',attempts=attempts+1,locked_at=? WHERE id=? AND status='pending'")
      .bind(clock, r.id).run();
    if (!claimed.meta.changes) continue;
    try {
      const content = `<@${r.user_id}> Nhắc nhở sự kiện: **${r.title.replace(/\*/g, '\\*')}**\n` +
        `Thời gian đã đặt: ${discordTime(r.due_at)}`;
      await discordRequest(`/channels/${r.channel_id}/messages`, env.DISCORD_BOT_TOKEN, 'POST', {
        content: clamp(content, 1900), allowed_mentions: { parse: [], users: [r.user_id] }
      });
      await env.DB.prepare("UPDATE reminders SET status='sent',sent_at=?,last_error=NULL WHERE id=? AND status='processing'")
        .bind(Date.now(), r.id).run();
    } catch (error) {
      console.error('Reminder send error:', r.id, error);
      const nextStatus = r.attempts + 1 >= 5 ? 'failed' : 'pending';
      const delay = Math.min(3600000, Math.pow(2, r.attempts + 1) * 60000);
      await env.DB.prepare('UPDATE reminders SET status=?,next_attempt_at=?,last_error=? WHERE id=?')
        .bind(nextStatus, clock + delay, clamp(error.message, 240), r.id).run();
    }
  }
}

async function handleComponent(interaction, env, ctx) {
  const id = interaction.data?.custom_id || '';
  const parts = id.split(':');
  if (parts[0] !== 'steam') return reply('Nút không được hỗ trợ.', true);
  const owner = parts[1] === 'pick' ? parts[2] : parts[4];
  if (owner !== requestUserId(interaction)) return reply('Chỉ người tìm game mới được chuyển trang / chọn game.', true);
  let appid; let page;
  if (parts[1] === 'pick') {
    appid = extractAppId(interaction.data?.values?.[0]);
    page = 0;
  } else if (parts[1] === 'page') {
    appid = extractAppId(parts[2]);
    page = Number(parts[3]);
  }
  if (!appid || !Number.isInteger(page) || page < 0 || page >= STEAM_PAGES.length) return reply('Lựa chọn không hợp lệ.', true);
  ctx.waitUntil(showSteam(interaction, appid, page, owner).catch(e => console.error('Component error:', e)));
  return json({ type: 6 }); // Defer UPDATE_MESSAGE to avoid the 3-second interaction timeout.
}

async function handleCommand(interaction, env, ctx) {
  const command = interaction.data?.name;
  if (command === 'steam') {
    const query = clamp(option(interaction, 'query')?.value, 100);
    if (!query) return reply('Nhập tên game hoặc AppID.', true);
    ctx.waitUntil(finishSteam(interaction, query, env));
    return json({ type: 5 });
  }
  if (command === 'member' || command === 'avatar') {
    if (!interaction.guild_id) return reply('Lệnh chỉ dùng trong server Discord.', true);
    ctx.waitUntil((async () => {
      try { await editOriginal(interaction, await userInfo(interaction, env)); }
      catch (e) {
        console.error('Member error:', e);
        try { await editOriginal(interaction, { content: 'Không tải được thông tin thành viên.' }); } catch {}
      }
    })());
    return json({ type: 5 });
  }
  if (command === 'remind') return reminderCommand(interaction, env);
  if (command === 'help') return reply(
    '**Steam & Events Bot**\n' +
    '`/steam query:` Tìm game theo AppID/tên, gợi ý khi nhập.\n' +
    '`/member user:` Xem thông tin thành viên (có thể bỏ trống user).\n' +
    '`/avatar user:` Xem avatar lớn.\n' +
    '`/remind create event when channel:` Đặt nhắc sự kiện.\n' +
    '`/remind list` và `/remind cancel id:` Xem/hủy nhắc.\n' +
    'Thời gian: `15m`, `2h`, `1d`, `1w` hoặc `YYYY-MM-DD HH:mm` (UTC+7).', true);
  return reply('Lệnh chưa được hỗ trợ. Dùng /help.', true);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return json({ status: 'ok', service: 'steam-discord-worker' });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    if (!env.DISCORD_PUBLIC_KEY) return new Response('Public key not configured', { status: 503 });
    const body = await request.text();
    if (!(await verifyRequest(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('Invalid signature', { status: 401 });
    let interaction;
    try { interaction = JSON.parse(body); }
    catch { return new Response('Invalid JSON', { status: 400 }); }
    if (interaction.type === 1) return json({ type: 1 });
    if (interaction.type === 4) return handleAutocomplete(interaction);
    if (interaction.type === 3) return handleComponent(interaction, env, ctx);
    if (interaction.type === 2) return handleCommand(interaction, env, ctx);
    return reply('Unsupported interaction', true);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(processReminders(env).catch(e => console.error('Cron error:', e)));
  }
};

// Pure helpers exported for local test, not reachable over HTTP.
export const __test = { parseWhen, extractAppId, makeSteamPage, searchSteam, getSteamApp, verifyRequest,
  processReminders, snowflakeDate, avatarUrl, removeHtml };

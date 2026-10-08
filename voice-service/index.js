/**
 * One Discord application, two runtimes:
 *  - Cloudflare Worker processes Slash Commands and stores D1 jobs.
 *  - This Node.js process holds ONLY the Gateway/voice connection.
 * No inbound HTTP port; this process pulls authenticated jobs from Worker.
 */
import { loadEnvFile } from 'node:process';
import { spawn, execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType,
  NoSubscriberBehavior, entersState
} from '@discordjs/voice';

try { loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* systemd env vars are fine */ }

const token = process.env.DISCORD_BOT_TOKEN;
const sharedSecret = process.env.VOICE_SHARED_SECRET;
const workerUrl = process.env.WORKER_URL;
const allowed = String(process.env.AUDIO_ALLOWED_HOSTS || 'youtube.com,youtu.be,soundcloud.com,soundhelix.com')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const pollMs = Math.max(2000, Number(process.env.POLL_INTERVAL_MS || 5000));
if (!token || !sharedSecret || !workerUrl || !workerUrl.startsWith('https://')) {
  throw Error('Missing DISCORD_BOT_TOKEN, VOICE_SHARED_SECRET or HTTPS WORKER_URL');
}
if (sharedSecret.length < 32) throw Error('VOICE_SHARED_SECRET must have >=32 characters');
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw Error('Install ffmpeg before starting voice-service');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const sessions = new Map(); // guild -> player, connection, current and queue
const execute = promisify(execFile);
const completedIds = new Map();

const api = (pathname) => new URL(pathname, workerUrl).href;
const headers = { Authorization: `Bearer ${sharedSecret}`, 'Content-Type': 'application/json' };

function allowedMediaUrl(text) {
  const u = new URL(text);
  if (u.protocol !== 'https:' || u.username || u.password) throw Error('Only public HTTPS URLs are supported');
  const hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!allowed.some(host => hostname === host || hostname.endsWith('.' + host))) {
    throw Error(`Host ${hostname} is not in AUDIO_ALLOWED_HOSTS`);
  }
  return u.href;
}

async function mediaStream(url) {
  const parsed = new URL(allowedMediaUrl(url));
  if (/\.(mp3|ogg|opus|m4a|aac|wav|flac|m3u8)$/i.test(parsed.pathname)) return url;
  // Extract supported streaming URLs (YouTube/SoundCloud and some other public sites).
  // Does not bypass DRM, private videos or authentication restrictions.
  const { stdout } = await execute('yt-dlp', [
    '--no-playlist', '--no-warnings', '-f', 'bestaudio/best', '-g', url
  ], { timeout: 20000, maxBuffer: 1024 * 64 });
  const resolved = stdout.trim().split(/\r?\n/)[0];
  if (!resolved || !resolved.startsWith('https://')) throw Error('Could not resolve a public HTTPS audio stream');
  return resolved;
}

async function say(channelId, text) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && channel.send) {
      await channel.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } });
    }
  } catch (e) { console.warn('Could not post voice status:', e?.message); }
}

function terminateFfmpeg(session) {
  const proc = session.ffmpeg;
  session.ffmpeg = null;
  if (proc && !proc.killed) proc.kill('SIGKILL');
}

async function playNext(session) {
  if (session.current || !session.queue.length) return;
  const item = session.queue.shift();
  session.current = item;
  const generation = ++session.generation;
  try {
    const streamUrl = await mediaStream(item.url);
    if (generation !== session.generation || !session.current) return;
    const proc = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
      '-i', streamUrl, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    session.ffmpeg = proc;
    let errText = '';
    proc.stderr.on('data', x => { errText = (errText + x.toString()).slice(-500); });
    proc.on('error', e => {
      console.error('ffmpeg spawn:', e);
      if (session.current === item) session.player.stop(true);
    });
    proc.on('close', code => {
      if (code !== 0 && session.current === item && !proc.killed) {
        void say(item.channel_id, `Không phát được âm thanh: ${errText || `FFmpeg exited ${code}`}`);
        session.player.stop(true);
      }
    });
    session.player.play(createAudioResource(proc.stdout, { inputType: StreamType.Raw, metadata: item }));
    await say(item.channel_id, `Đang phát: ${item.url}`);
  } catch (e) {
    console.error('playNext error:', e);
    await say(item.channel_id, `Không phát được link: ${e.message}`);
    session.current = null;
    terminateFfmpeg(session);
    void playNext(session);
  }
}

async function newSession(guild, voiceChannelId) {
  const connection = joinVoiceChannel({
    channelId: voiceChannelId, guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator, selfDeaf: true
  });
  try { await entersState(connection, VoiceConnectionStatus.Ready, 20000); }
  catch (e) { connection.destroy(); throw Error(`Unable to join voice channel: ${e.message}`); }
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection.subscribe(player);
  const session = { connection, player, voiceChannelId, queue: [], current: null, ffmpeg: null, generation: 0 };
  player.on(AudioPlayerStatus.Idle, () => {
    session.current = null;
    terminateFfmpeg(session);
    void playNext(session);
  });
  player.on('error', e => {
    console.error('Voice playback error:', e);
    const channelId = session.current?.channel_id;
    if (channelId) void say(channelId, `Lỗi phát nhạc: ${e.message}`);
    session.player.stop(true);
  });
  connection.on('error', e => console.error('Voice connection error:', e));
  sessions.set(guild.id, session);
  return session;
}

async function executeJob(job) {
  const guild = client.guilds.cache.get(job.guild_id);
  if (!guild) throw Error('Bot is not a member of this guild');
  const userVoice = guild.voiceStates.cache.get(job.user_id)?.channelId;
  let session = sessions.get(guild.id);
  if (job.action === 'play') {
    if (!userVoice) throw Error('Bạn cần vào phòng thoại trước khi /play');
    if (session && session.voiceChannelId !== userVoice) throw Error('Bot đang ở phòng thoại khác');
    const url = allowedMediaUrl(job.url);
    if (!session) session = await newSession(guild, userVoice);
    if (session.queue.length >= 20) throw Error('Hàng đợi đã đủ 20 bài');
    session.queue.push({ url, channel_id: job.channel_id });
    void playNext(session);
    return;
  }
  if (!session) {
    if (job.action === 'queue') return say(job.channel_id, 'Hàng đợi hiện đang trống.');
    throw Error('Bot chưa phát nhạc trong server này');
  }
  if (job.action === 'queue') {
    const lines = [session.current?.url ? `Đang phát: ${session.current.url}` : 'Không có bài đang phát',
      ...session.queue.map((x, i) => `${i + 1}. ${x.url}`)];
    return say(job.channel_id, lines.join('\n'));
  }
  // Control playback only for members in the SAME voice room.
  if (!userVoice || userVoice !== session.voiceChannelId) throw Error('Bạn cần ở cùng phòng thoại với bot để điều khiển');
  switch (job.action) {
    case 'pause':
      if (!session.player.pause()) throw Error('Không thể tạm dừng hiện tại');
      break;
    case 'resume':
      if (!session.player.unpause()) throw Error('Không có bài đang tạm dừng');
      break;
    case 'skip': {
      if (!session.current) throw Error('Không có bài đang phát');
      const wasPlaying = session.player.state.status !== AudioPlayerStatus.Idle;
      session.generation++;
      session.current = null;
      terminateFfmpeg(session);
      session.player.stop(true);
      if (!wasPlaying) void playNext(session); // No Idle event while resolving URL.
      break;
    }
    case 'stop':
      session.generation++;
      session.queue = [];
      session.current = null;
      terminateFfmpeg(session);
      session.player.stop(true);
      session.connection.destroy();
      sessions.delete(guild.id);
      break;
    default: throw Error('Unknown action');
  }
}

async function poll() {
  const result = await fetch(api('/voice/jobs'), { headers, signal: AbortSignal.timeout(12000) });
  if (!result.ok) throw Error(`Worker poll HTTP ${result.status}: ${await result.text()}`);
  const { jobs } = await result.json();
  for (const job of jobs || []) {
    let { ok = true, error = '' } = completedIds.get(job.id) || {};
    if (!completedIds.has(job.id)) {
      try { await executeJob(job); }
      catch (e) {
        ok = false;
        error = e.message || String(e);
        console.error(`Voice job ${job.id}:`, error);
        await say(job.channel_id, `Không thực hiện được /${job.action}: ${error}`);
      }
    }
    // Remember exact result if ACK fails, preventing a second playback in this process.
    completedIds.set(job.id, { ok, error });
    if (completedIds.size > 1000) completedIds.delete(completedIds.keys().next().value);
    const ack = await fetch(api('/voice/ack'), {
      method: 'POST', headers, body: JSON.stringify({ id: job.id, ok, error }),
      signal: AbortSignal.timeout(12000)
    });
    if (!ack.ok) throw Error(`Worker ACK HTTP ${ack.status}`);
  }
}

async function run() {
  await client.login(token);
  if (!client.isReady()) await new Promise(resolve => client.once(Events.ClientReady, resolve));
  console.log(`Voice Service logged in as ${client.user.tag}. Poll: ${pollMs} ms`);
  for (;;) {
    try { await poll(); } catch (e) { console.error('Voice poll:', e.message); }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
run().catch(e => { console.error(e); process.exitCode = 1; });

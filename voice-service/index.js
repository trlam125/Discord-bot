/**
 * One Discord application, two runtimes:
 *  - Cloudflare Worker processes Slash Commands and stores D1 jobs.
 *  - This Node.js process holds ONLY the Gateway/voice connection.
 * No inbound HTTP port; this process pulls authenticated jobs from Worker.
 */
import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
import { parsePublicHttpsUrl, resolveMediaInput } from './media-url.js';
import { fallbackConfigured, resolveFallbackMedia } from './fallback-provider.js';
import { prepareAudioStream } from './ffmpeg-audio.js';
import { tryPrimaryThenFallback } from './two-stage.js';
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
const pollMs = Math.max(2000, Number(process.env.POLL_INTERVAL_MS || 5000));
if (!token || !sharedSecret || !workerUrl || !workerUrl.startsWith('https://')) {
  throw Error('Missing DISCORD_BOT_TOKEN, VOICE_SHARED_SECRET or HTTPS WORKER_URL');
}
if (sharedSecret.length < 32) throw Error('VOICE_SHARED_SECRET must have >=32 characters');
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw Error('Install ffmpeg before starting voice-service');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const sessions = new Map(); // guild -> player, connection, current and queue
const completedIds = new Map();

const api = (pathname) => new URL(pathname, workerUrl).href;
const headers = { Authorization: `Bearer ${sharedSecret}`, 'Content-Type': 'application/json' };

// Public URL verification and supported-site extraction are in media-url.js.
// Apply an OS/container egress guard on ANY host: redirects, HLS and DNS rebinding bypass JavaScript DNS checks.

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

function activeTrack(session, item, generation) {
  return session.current === item && session.generation === generation && !session.controller?.signal.aborted;
}

function finishFailedTrack(session, item, generation, error) {
  if (!activeTrack(session, item, generation)) return;
  console.warn(`Voice track failed (${error?.message || 'unknown error'})`);
  void say(item.channel_id, `Không phát được link: ${error?.message || 'Nguồn không khả dụng.'}`);
  session.transitioning = true;
  session.current = null;
  session.controller?.abort();
  terminateFfmpeg(session);
  session.player.stop(true);
  session.transitioning = false;
  void playNext(session);
}

/** Source mode is resolved per song; no configuration is tied to AWS. */
async function startSource(session, item, generation, mode) {
  const streamUrl = mode === 'direct'
    ? await resolveMediaInput(item.url)
    : await resolveFallbackMedia(item.url);
  if (!activeTrack(session, item, generation)) return false;
  let decoder;
  try {
    decoder = await prepareAudioStream(streamUrl, {
      signal: session.controller.signal,
      onSpawn: proc => { session.ffmpeg = proc; },
      timeoutMs: process.env.MEDIA_START_TIMEOUT_MS || 18000
    });
  } catch (error) {
    if (session.ffmpeg) terminateFfmpeg(session);
    throw error;
  }
  if (!activeTrack(session, item, generation)) {
    decoder.proc.kill('SIGKILL');
    return false;
  }
  session.ffmpeg = decoder.proc;
  session.player.play(createAudioResource(decoder.stream, { inputType: StreamType.Raw, metadata: item }));
  session.transitioning = false;
  decoder.proc.on('close', code => {
    if (!activeTrack(session, item, generation) || session.ffmpeg !== decoder.proc || decoder.proc.killed) return;
    if (code !== 0) {
      if (mode === 'direct' && fallbackConfigured()) {
        void switchToFallback(session, item, generation);
      } else {
        finishFailedTrack(session, item, generation, Error('Nguồn âm thanh bị gián đoạn, không thể tiếp tục phát.'));
      }
    }
  });
  await say(item.channel_id, mode === 'direct'
    ? `Đang phát (nguồn trực tiếp): ${item.url}`
    : `Đang phát (nguồn trung gian): ${item.url}`);
  return true;
}

async function switchToFallback(session, item, generation) {
  if (!activeTrack(session, item, generation) || session.transitioning) return;
  session.transitioning = true; // Prevent Idle from removing this song during retry.
  terminateFfmpeg(session);
  session.player.stop(true);
  await say(item.channel_id, 'Nguồn trực tiếp lỗi, đang thử nguồn trung gian...');
  if (!activeTrack(session, item, generation)) return;
  try {
    await startSource(session, item, generation, 'fallback');
  } catch (error) {
    finishFailedTrack(session, item, generation, error);
  }
}

async function playNext(session) {
  if (session.current || !session.queue.length) return;
  const item = session.queue.shift();
  session.current = item;
  session.transitioning = true;
  session.controller = new AbortController();
  const generation = ++session.generation;
  try {
    await tryPrimaryThenFallback(
      () => startSource(session, item, generation, 'direct'),
      async () => {
        // Direct URL resolution failed or FFmpeg emitted no PCM.
        session.transitioning = false;
        await switchToFallback(session, item, generation);
      },
      () => fallbackConfigured() && activeTrack(session, item, generation)
    );
  } catch (error) {
    finishFailedTrack(session, item, generation, error);
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
  const session = { connection, player, voiceChannelId, queue: [], current: null, ffmpeg: null, generation: 0, transitioning: false, controller: null };
  const completeTrack = () => {
    if (session.transitioning || !session.current) return;
    session.current = null;
    session.controller?.abort();
    terminateFfmpeg(session);
    void playNext(session);
  };
  player.on(AudioPlayerStatus.Idle, () => {
    if (session.transitioning) return;
    const proc = session.ffmpeg;
    // stdout can finish before the child close event reports an FFmpeg error.
    // Wait for close so that direct playback can fall back instead of
    // incorrectly treating a failed stream as a finished song.
    if (proc && !proc.killed && proc.exitCode !== 0) {
      if (proc.exitCode === null) {
        proc.once('close', () => {
          if (session.ffmpeg === proc && !session.transitioning && proc.exitCode === 0) completeTrack();
        });
      }
      return;
    }
    completeTrack();
  });
  player.on('error', e => {
    console.error('Voice playback error:', e);
    const channelId = session.current?.channel_id;
    if (channelId) void say(channelId, 'Lỗi truyền âm thanh tới Discord.');
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
    const url = parsePublicHttpsUrl(job.url);
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
      session.generation++;
      session.controller?.abort();
      session.current = null;
      session.transitioning = false;
      terminateFfmpeg(session);
      session.player.stop(true);
      void playNext(session); // Also handles skip while resolver/FFmpeg has not started.
      break;
    }
    case 'stop':
      session.generation++;
      session.controller?.abort();
      session.transitioning = false;
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

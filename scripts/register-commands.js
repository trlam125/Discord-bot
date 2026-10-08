#!/usr/bin/env node
import { readFileSync } from "node:fs";
import readline from 'node:readline';

const commands = [
  {
    name: 'steam',
    description: 'Tra cuu game Steam theo AppID hoac ten game',
    type: 1,
    options: [
      {
        type: 3,
        name: 'query',
        description: 'AppID / ten game / Steam URL',
        required: true,
        autocomplete: true,
        max_length: 100,
      },
    ],
  },
  {
    name: 'member',
    description: 'Xem thong tin thanh vien trong server',
    type: 1,
    options: [
      {
        type: 6,
        name: 'user',
        description: 'Thanh vien (de trong = ban)',
        required: false,
      },
    ],
  },
  {
    name: 'avatar',
    description: 'Xem avatar Discord chat luong cao',
    type: 1,
    options: [
      {
        type: 6,
        name: 'user',
        description: 'Thanh vien (de trong = ban)',
        required: false,
      },
    ],
  },
  {
    name: 'remind',
    description: 'Dat lich nhac su kien tu dong',
    type: 1,
    options: [
      {
        type: 1,
        name: 'create',
        description: 'Tao nhac nho',
        options: [
          {
            type: 3,
            name: 'event',
            description: 'Ten su kien',
            required: true,
            max_length: 180,
          },
          {
            type: 3,
            name: 'when',
            description: '15m / 2h / 1d / YYYY-MM-DD HH:mm (UTC+7)',
            required: true,
          },
          {
            type: 7,
            name: 'channel',
            description: 'Kenh gui nhac (mac dinh kenh hien tai)',
            required: false,
            channel_types: [0, 5],
          },
        ],
      },
      {
        type: 1,
        name: 'list',
        description: 'Xem nhac nho da tao',
      },
      {
        type: 1,
        name: 'cancel',
        description: 'Huy nhac nho',
        options: [
          {
            type: 4,
            name: 'id',
            description: 'ID tu lenh /remind list',
            required: true,
            min_value: 1,
          },
        ],
      },
    ],
  },
  {
    name: 'play', description: 'Phat am thanh HTTPS trong phong thoai', type: 1,
    options: [{ type: 3, name: 'url', description: 'YouTube/SoundCloud hoac link MP3 cong khai', required: true, max_length: 900 }],
  },
  { name: 'pause', description: 'Tam dung phat nhac', type: 1 },
  { name: 'resume', description: 'Tiep tuc phat nhac', type: 1 },
  { name: 'skip', description: 'Chuyen bai dang phat', type: 1 },
  { name: 'queue', description: 'Danh sach nhac dang cho', type: 1 },
  { name: 'stop', description: 'Dung nhac va roi phong thoai', type: 1 },
  {
    name: 'help',
    description: 'Huong dan su dung Discord Steam Bot',
    type: 1,
  },
  JSON.parse(readFileSync(new URL('./free-commands.json', import.meta.url), 'utf8')),
];

async function ask(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

async function main() {
  const appId =
    process.env.DISCORD_APPLICATION_ID ||
    (await ask('Discord Application ID: '));
  const guildId =
    process.env.DISCORD_GUILD_ID ||
    (await ask('Discord Server (Guild) ID: '));
  const token =
    process.env.DISCORD_BOT_TOKEN ||
    (await ask('Discord Bot Token: '));

  if (!/^\d{17,22}$/.test(appId)) {
    throw new Error('Application ID must be a valid Discord snowflake ID (17-22 digits).');
  }
  if (!/^\d{17,22}$/.test(guildId)) {
    throw new Error('Guild ID must be a valid Discord snowflake ID (17-22 digits).');
  }
  if (!token) {
    throw new Error('Bot token is required.');
  }

  const url = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
  console.log(`Registering commands to Guild ${guildId}...`);

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Registration failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  console.log(`Successfully registered ${data.length} commands!`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

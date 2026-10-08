# Discord Steam + Reminder Bot (Cloudflare Workers, free tier)

A complete HTTP-interactions Discord bot built for **Cloudflare Workers**.
It does **not** keep a Discord Gateway connection running. Slash commands work
when properly installed even if Discord shows the bot as offline.

## Features

- `/steam query:` Lookup by AppID or Steam URL. Type part of a game title to
  see Discord autocomplete suggestions. If a name is submitted without a
  suggestion, choose from a dropdown. Four pages display game info, screenshots,
  trailer links, requirements, DLC, publishers, release date and prices (where
  available from Steam Store).
- `/member user:` Profile name, ID, Discord account creation, guild join date,
  roles, avatar and banner (when public); defaults to yourself.
- `/avatar user:` Large user avatar and guild-specific avatar when available.
- `/remind create event when channel:` Store a reminder in D1 and send it
  from a one-minute Cron Trigger at the scheduled time.
- `/remind list` / `/remind cancel id` / `/help`.

**Dates**: `2h`, `30m`, `1d`, `1w`, `2026-10-15 20:30` (Vietnam time UTC+7).
Use explicit RFC3339 timezone strings for other time zones.
Minimum one minute into the future, maximum 365 days, 25 active per user/server.

No paid Steam API key is required. Steam Store public unofficial endpoints may
rate-limit/deny requests or temporarily fail, especially from hosting networks.
The bot only displays fields Steam returns, not private Steam account data.

## A. Cloudflare Dashboard: easiest for the Hello World Worker you started

1. In **Discord Developer Portal** (https://discord.com/developers/applications)
   create/select your application. Copy **Application ID** and **Public Key**.
   Under Bot, reset/copy the **Bot Token**; keep it secret.
2. In **Cloudflare Dashboard > Workers & Pages** select your Worker (e.g.
   `discord-test-bot`) > **Edit code**. Replace the entire script with the
   contents of **`src/index.js`**, then click **Deploy**.
3. In **Worker > Settings > Variables and Secrets**, add:

   | Name | Kind | Value |
   | --- | --- | --- |
   | `DISCORD_PUBLIC_KEY` | Secret or text | Public Key from Discord General Information |
   | `DISCORD_BOT_TOKEN` | Secret (encrypted) | Bot Token from Discord Bot |

   NEVER paste the Bot Token into source code, screenshots, git, or chats.
4. Go to **Cloudflare > Storage & databases > D1 SQL Database > Create**.
   Name the database `discord-reminders`. Open its **Console** (SQL editor),
   paste all of **`schema.sql`**, and execute it. Verify `reminders` table exists.
5. Go back to the Worker > **Settings > Bindings > Add > D1 database**.
   Choose the database above. **Variable name MUST be `DB`**; save/deploy.
6. Worker > **Settings > Triggers > Cron Triggers > Add**. Enter
   `* * * * *` (every minute, UTC). Save. It can take a few minutes to propagate.
7. Copy the Worker URL, e.g. `https://discord-test-bot.YOUR-SUBDOMAIN.workers.dev`.
   In Discord Developer Portal > **General Information** set
   **Interactions Endpoint URL** to this URL, and save. Discord sends a signed
   PING to verify the endpoint.
8. In Discord Developer Portal > **Installation**, enable Guild Install with
   `bot` + `applications.commands` scopes. Set bot permissions **View Channels**,
   **Send Messages**, **Embed Links**. Use the install link to install in your
   server. You do not need Message Content or Server Members privileged intents
   to make these commands work.
9. In Discord app Settings > Advanced, enable Developer Mode, right-click your
   server and copy **Server ID**. In Windows PowerShell inside the extracted
   project folder run:

   ```powershell
   .\scripts\register-commands.ps1
   ```

   Or cross-platform via Node.js:

   ```bash
   npm run register
   ```

   Enter Application ID, Server ID, and Bot Token when asked.
   **Warning: this PUT replaces the application's existing guild slash commands.**
   These five commands should now show in that server.

10. Test `/help`, `/steam query:570`, `/steam query:portal`, `/member`,
    `/avatar` and `/remind create` with `event: Thu bot` and `when: 2m`.
    For events, confirm the bot can send messages in the destination channel.

### Common errors

- **Invalid Interaction Endpoint**: Did you deploy code, set the correct Public
  Key, save the Worker variables, and use the actual Worker URL (not `/api`)?
  The bot verifies Ed25519 signatures and returns `{ "type":1 }` for valid PINGs.
- **Slash commands do not appear**: Re-run the registration script, check
  `applications.commands` scope and that Guild ID is correct.
- **Steam search does not return games**: Steam's *unofficial* Store endpoints
  sometimes block/rate-limit requests. Check Worker logs under Observability.
- **Reminder database error**: Bind D1 with the EXACT variable name `DB`,
  run `schema.sql`, and redeploy your Worker.
- **Reminder never arrives**: Check Cron Trigger and token, confirm bot has
  channel permissions and inspect Worker logs and D1 reminders `status`.
- **Bot appears offline**: Expected for HTTP Interactions applications.
- **Reminder arrives a little late**: Cloudflare Cron Triggers are not an
  exact-to-the-second real-time scheduler; allow slight delays.

## B. Optional: Deploy with Wrangler CLI instead of the web editor

You can also manage the Worker as a reproducible code project:

```powershell
npm install
npx wrangler login
npx wrangler d1 create discord-reminders
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

Edit `wrangler.jsonc`: replace `REPLACE_WITH_REAL_D1_DATABASE_ID` with
`database_id` printed by the create command. Then:

```powershell
npm run db:init
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npm run deploy
npm test
```

Configure Discord's Interactions Endpoint URL as described in part A.
If this is already deployed by the Dashboard, use **the same Worker name** in
`wrangler.jsonc`, or Wrangler will create a second Worker.
Do not manage the same Worker's Cron Triggers manually and via Wrangler at once.

## Security and operation notes

- Every Discord POST is verified against the original body + timestamp using
  Ed25519 and the configured Public Key, with a 5-minute timestamp window.
- Only the person who searched a game can use that result's menu/page buttons.
- Only the creator can cancel or view their own reminders within the guild.
- The bot never needs Steam authentication or privileged Discord intents.
- D1 saves events persistently, with atomic claims and retries (max 5). In
  rare network failures after Discord accepts a message but before its response
  reaches the Worker, duplicate notifications are still possible.
- Only timed manual reminders are included. Automatic sync with Discord
  Scheduled Events is NOT included (can be added separately).
- The public Steam endpoints are not guaranteed stable, and some game fields
  (price/reviews/DLC/requirements) may be absent or depend on region.
- Cloudflare free quotas apply to Worker requests and D1 operations; monitor
  actual usage in Cloudflare Dashboard.

Official docs:
- https://docs.discord.com/developers/topics/interactions
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/d1/
- https://developers.cloudflare.com/workers/platform/pricing/

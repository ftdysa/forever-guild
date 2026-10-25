# Discord Webhook — Design

Date: 2026-10-25

## Purpose

Announce new roster members in the guild Discord so people see who joined
without opening the site.

## Decisions (from brainstorming)

- Event: new member only (`POST /api/members` success). Updates and deletes
  do not post. Guild-import adds go through the same route, so they post too.
- Format: a Discord embed in the main class colour.
- Delivery: fire-and-forget webhook POST after the insert. No outbox, no
  retries; a post lost to a Discord outage or 429 is acceptable.
- Optional: unset `DISCORD_WEBHOOK_URL` disables the feature entirely.

## Config

- `DISCORD_WEBHOOK_URL` (optional, secret). Must match
  `https://discord.com/api/webhooks/...` or `https://discordapp.com/api/webhooks/...`;
  any other value fails startup with a clear error. Never logged.
- `SITE_URL` (optional). Must be an `http(s)` URL when set. Used as the embed
  link; omitted from the embed when unset.
- `Config.discord?: { webhookUrl: string; siteUrl?: string }`, undefined when
  the webhook is unset. Setting `SITE_URL` alone does not enable anything.
- Documented in `.env.example`, README and the `fly.toml` secrets comment
  (`fly secrets set DISCORD_WEBHOOK_URL=...`).

## Embed

`buildJoinEmbed(member, siteUrl?)` — pure, in `src/discord.ts`:

- Title: `<characterName> joined the roster`; `url` = `siteUrl` when set.
- Colour: main class colour as an integer. Priest `#FFFFFF` is replaced with
  `#C0C0C0` so it stays visible on Discord's light theme.
- Fields (inline where they fit), names resolved from `game-data`:
  - Main: `Shaman — Enhancement`
  - Backup: same format; omitted when no backup.
  - Professions: primary then secondary, comma-separated; omitted when none.
  - Style: sweat factor and leveling pref joined with ` · `; omitted when
    both unset.
- Notes are never included (free text).
- Timestamp: member `createdAt`.

Request body: `{ embeds: [embed], allowed_mentions: { parse: [] } }`.
Character names are letters only (`NAME_RE`), but `allowed_mentions` keeps
any future field from pinging.

## Notifier

`DiscordNotifier` in `src/discord.ts`:

- Constructed with the discord config, an injectable `FetchFn` (same pattern
  as `blizzardFetch`), and a logger.
- `memberJoined(member): Promise<void>` — POSTs JSON with a 5 s
  `AbortSignal.timeout`. Never throws: non-2xx logs `warn` with the status;
  network/timeout errors log `warn` with the error message. The webhook URL is
  not included in log lines.
- Decorated on the app as `app.notifier: DiscordNotifier | null`, mirroring
  `app.armory`. `AppDeps` gains `discordFetch?: FetchFn`.

## Route

In `POST /members`, after the audit call:
`void app.notifier?.memberJoined(created);` — not awaited, so the 201 is not
delayed or affected by Discord.

## Testing

- `test/discord.test.ts`: embed fields and names, missing backup/professions/
  style omitted, Priest colour override, `url` only with `siteUrl`, notes
  absent; notifier swallows non-2xx and thrown fetch errors.
- `test/config.test.ts`: webhook unset → `discord` undefined; valid URL
  accepted; non-Discord or `http://` URL rejected; bad `SITE_URL` rejected.
- `test/api.test.ts` (or a new `discord-api.test.ts`) with a fake fetch:
  create posts once with the expected body; update and delete post nothing;
  failing fetch still returns 201; no webhook configured → no fetch calls.

## Out of scope

Leave/edit announcements, retries/outbox, raid events, Discord bot features.

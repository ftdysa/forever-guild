# Old School Guild Roster

The roster mirrors the guild on the WoW armory: every member of
`BLIZZARD_GUILD` appears automatically with their class, level, professions and
a main spec guessed from talents. Members add a backup class/spec, sweat factor,
leveling preference and notes, and can override the guessed main spec.
Everyone behind the guild passphrase sees the full roster and coverage counts.

## Run with Docker

```bash
cp .env.example .env   # set GUILD_PASSPHRASE and a long random SESSION_SECRET
docker compose up -d --build
```

SESSION_SECRET must be at least 32 characters (`openssl rand -hex 32`).
GUILD_PASSPHRASE must be at least 16 characters. Sessions are stored server-side:
logging out revokes the session, and changing GUILD_PASSPHRASE or SESSION_SECRET
logs everyone out on the next restart.

Open http://localhost:3000. Data persists in `./data/roster.db`.

## Run locally

```bash
npm install
cp .env.example .env
set -a; source .env; set +a
npm run dev
```

## Test

```bash
npm run lint
npm run typecheck
npm test
```

## CI / deploy

- Pull requests run lint, typecheck, and tests (`.github/workflows/ci.yml`).
- Pushes to `main` run the same checks, then `flyctl deploy` to the
  `old-school` Fly app (`.github/workflows/deploy.yml`). Needs a
  `FLY_API_TOKEN` repo secret from `fly tokens create deploy`.

## API

All routes under `/api`. Everything except `GET /api/game-data` and
`POST /api/login` needs the session cookie set by login.

| Method | Path               | Notes                               |
|--------|--------------------|-------------------------------------|
| GET    | /api/game-data     | classes, specs, roles, professions, sweat factors, leveling prefs |
| POST   | /api/login         | `{ passphrase }` → 204 + cookie     |
| POST   | /api/logout        | clears cookie                       |
| GET    | /api/members       | syncs with the guild, then the roster sorted by name |
| PUT    | /api/members/:id   | edit details (`mainSpec`, `backupClass`, `backupSpec`, `sweatFactor`, `levelingPref`, `notes`) → 200 |
| GET    | /api/armory/status | `{ enabled, region, namespace, realm, guild, wowheadItemUrl }`; `realm` is null on Forever |
| GET    | /api/armory/character/:name | level, gear, talent-inferred spec, avatar; 404 unknown (on Forever: not in the guild), 502 Blizzard down |
| GET    | /api/crafting      | recipe catalog + who knows each recipe (Forever only; 404 otherwise) |

Errors: `{ error, details? }` with 400 / 401 / 404 / 409 / 429 / 500 / 502.

## Armory and guild sync (Blizzard API)

With `BLIZZARD_*` set (see `.env.example`), the roster is the guild's roster and
character names open an armory view with gear, item level, and a spec guessed
from talent points. Without it the roster stays empty.

The roster syncs when someone loads it and every 15 minutes while the server
runs. Newcomers are added, levels and ranks updated, and characters who left
the guild are removed along with their details. Each member's spec,
professions (with skill), race, title, item level, last login, achievement
points and Legacy progress are re-read from the armory in the background, four
characters at a time. Blizzard publishes no profile below level 10, so those
members show only roster data until they level.

Guild rank names aren't in Blizzard's API; set `GUILD_RANKS` to a
comma-separated list starting at rank 0 (e.g. `Guild Master,Officer,Member`).
Unnamed ranks show as "Rank N".

The armory dialog adds reputations, PvP rank and honorable kills, profession
skill bars and Legacy progress. Legacy challenges are found by reading every
achievement definition (static data, cached for a week) and keeping those whose
reward is a Legacy Point; a character's count is account-wide. Armory data only
fills an empty main spec, so a spec chosen on the site sticks. On Fly the
machine stops when idle, so syncs (and join announcements) wait for the next
visit unless `min_machines_running = 1`.

WoW Forever (`BLIZZARD_NAMESPACE=forever`) has no realms: characters are
addressed as `name-surname`. The app looks the surname up in the guild roster,
so armory lookups only cover members of `BLIZZARD_GUILD`.

- Calls go server-side with client credentials; the secret never reaches the browser.
- Responses are cached in SQLite:
  - Guild roster: 15 minutes.
  - Characters: no hard expiry. After 15 minutes a view sends one conditional
    request (`If-Modified-Since`, which Blizzard ties to the character's last
    login). 304 keeps the cache; 200 means they played, and the character is
    refetched in one parallel round (up to 8 profile calls + 1 icon search).
  - Item icons: one media search per 100 uncached items, kept for a year.
- If Blizzard is down, cached data is served; without a cache the API returns 502.
- On Fly, set the credentials as secrets: `fly secrets set BLIZZARD_CLIENT_ID=... BLIZZARD_CLIENT_SECRET=...`.
  Namespace and guild live in `fly.toml` `[env]`.

### Switching guilds / wiping PoC data

`reset-data` deletes every member and all cached armory data. Sessions are kept.

```bash
npm run reset-data -- --yes                     # local, uses DB_PATH
fly ssh console -C "setpriv --reuid=node --regid=node --init-groups node dist/reset-data.js --yes"
```

Run it as `node` on Fly (as above) so SQLite's WAL files stay owned by the app
user. Then update `BLIZZARD_REALM` / `BLIZZARD_GUILD` and deploy.

## Discord announcements

Optional. With `DISCORD_WEBHOOK_URL` set (see `.env.example`), each character
the guild sync finds joining the guild is posted to that channel as an embed in
their class colour, linking to `SITE_URL` when set. The first sync into an empty
roster seeds it without posting. Edits and departures are not posted. Delivery
is best-effort: if Discord is down the post is dropped.

- The webhook URL is a secret. On Fly: `fly secrets set DISCORD_WEBHOOK_URL=...`.

## Crafting directory

On Forever, the Crafting tab lists every recipe in Alchemy, Blacksmithing,
Enchanting, Engineering, Leatherworking, Tailoring, Cooking, First Aid and
Mining (smelting), who in the guild knows it (with their skill), and its
reagents. Search matches recipe, item and reagent names; "Nobody knows yet"
shows the gaps.

- Known recipes come from each member's armory professions, read by the
  guild sync. Members below level 10 have no armory profile, so none show.
- The recipe catalog (~2,500 recipes) is read from Blizzard's static data
  8 calls at a time, stored in SQLite, and rebuilt when Blizzard's game build
  changes (checked at startup and daily). A failed build keeps the old one.
- To rebuild it by hand (rarely needed):

  ```bash
  npm run refresh-recipes                         # local, uses DB_PATH
  fly ssh console -C "setpriv --reuid=node --regid=node --init-groups node dist/refresh-recipes.js"
  ```

  The CLI has its own rate limiter, separate from the server's, so run it when the server
  is not building the catalog (e.g. not right after a deploy) to stay under Blizzard's limit.

## Security notes

- Serve behind a TLS reverse proxy for anything beyond localhost.
- Set `COOKIE_SECURE=true` and `TRUST_PROXY=true` when doing so.
- `TRUST_PROXY=true` trusts exactly one proxy hop. If your proxy sets a trusted
  client-IP header (Fly sets `fly-client-ip`), set `CLIENT_IP_HEADER` to it instead.
- Login is rate-limited to 10 attempts per minute per client IP.
- Logins and member create/update/delete are logged with the client IP (`audit` field).
- Armory character lookups are rate-limited to 60 per minute per client IP, and
  names are validated (letters only) before any Blizzard call.
- The container starts as root only to chown `/data`, then runs as `node`.

## Design

See `docs/superpowers/specs/2026-10-14-guild-roster-design.md`.

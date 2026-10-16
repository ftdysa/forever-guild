# Geriatrics Guild Roster

Guild members claim a main class/spec, an optional backup class/spec, two
primary professions, secondary professions, and optionally a sweat factor
and leveling preference. Everyone behind the guild
passphrase sees the full roster and coverage counts.

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
  `geriatrics-guild` Fly app (`.github/workflows/deploy.yml`). Needs a
  `FLY_API_TOKEN` repo secret from `fly tokens create deploy`.

## API

All routes under `/api`. Everything except `GET /api/game-data` and
`POST /api/login` needs the session cookie set by login.

| Method | Path               | Notes                               |
|--------|--------------------|-------------------------------------|
| GET    | /api/game-data     | classes, specs, roles, professions, sweat factors, leveling prefs |
| POST   | /api/login         | `{ passphrase }` → 204 + cookie     |
| POST   | /api/logout        | clears cookie                       |
| GET    | /api/members       | roster sorted by name               |
| POST   | /api/members       | create → 201                        |
| PUT    | /api/members/:id   | replace → 200                       |
| DELETE | /api/members/:id   | → 204                               |
| GET    | /api/armory/status | `{ enabled, region, namespace, realm, guild, wowheadItemUrl }` |
| GET    | /api/armory/roster | guild members with `onRoster` flag; 404 when disabled |
| GET    | /api/armory/character/:name | level, gear, talent-inferred spec, avatar; 404 unknown, 502 Blizzard down |

Errors: `{ error, details? }` with 400 / 401 / 404 / 409 / 429 / 500 / 502.

## Armory (Blizzard API)

Optional. With `BLIZZARD_*` set (see `.env.example`), the roster gets an
"Import from Guild" button and character names open an armory view with gear,
item level, and a spec guessed from talent points.

- Calls go server-side with client credentials; the secret never reaches the browser.
- Responses are cached in SQLite (roster 6h, characters 3h). If Blizzard is down,
  stale cache is served; without a cache the API returns 502.
- Classic Era has no professions endpoint, so professions stay manual there. On
  realms that expose it, import pre-fills them.
- On Fly, set the credentials as secrets: `fly secrets set BLIZZARD_CLIENT_ID=... BLIZZARD_CLIENT_SECRET=...`.
  Realm and guild live in `fly.toml` `[env]`.

### Switching guilds / wiping PoC data

`reset-data` deletes every member and all cached armory data. Sessions are kept.

```bash
npm run reset-data -- --yes                     # local, uses DB_PATH
fly ssh console -C "setpriv --reuid=node --regid=node --init-groups node dist/reset-data.js --yes"
```

Run it as `node` on Fly (as above) so SQLite's WAL files stay owned by the app
user. Then update `BLIZZARD_REALM` / `BLIZZARD_GUILD` and deploy.

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

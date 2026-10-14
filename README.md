# WoW Forever Guild Roster

Guild members claim a main class/spec, an optional backup class/spec, two
primary professions, and secondary professions. Everyone behind the guild
passphrase sees the full roster and coverage counts.

## Run with Docker

```bash
cp .env.example .env   # set GUILD_PASSPHRASE and a long random SESSION_SECRET
docker compose up -d --build
```

SESSION_SECRET must be at least 32 characters (`openssl rand -hex 32`).
Changing GUILD_PASSPHRASE does not log anyone out; rotate SESSION_SECRET to
invalidate all sessions.

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
npm test
npm run typecheck
```

## API

All routes under `/api`. Everything except `GET /api/game-data` and
`POST /api/login` needs the session cookie set by login.

| Method | Path               | Notes                               |
|--------|--------------------|-------------------------------------|
| GET    | /api/game-data     | classes, specs, roles, professions  |
| POST   | /api/login         | `{ passphrase }` → 204 + cookie     |
| POST   | /api/logout        | clears cookie                       |
| GET    | /api/members       | roster sorted by name               |
| POST   | /api/members       | create → 201                        |
| PUT    | /api/members/:id   | replace → 200                       |
| DELETE | /api/members/:id   | → 204                               |

Errors: `{ error, details? }` with 400 / 401 / 404 / 409 / 500.

## Security notes

- Serve behind a TLS reverse proxy for anything beyond localhost.
- Set `COOKIE_SECURE=true` and `TRUST_PROXY=true` when doing so.
- Login is rate-limited to 10 attempts per minute per IP.

## Design

See `docs/superpowers/specs/2026-10-14-guild-roster-design.md`.

# WoW Forever Guild Roster — Design

Date: 2026-10-14

## Purpose

A small web app where guild members claim a main class, a backup class, and
their professions, so the whole guild can see coverage at a glance. It is a
coverage board, not an enforcement tool: it records and displays, it does not
block or warn.

## Decisions (from brainstorming)

- Game data: Classic WoW. 9 classes with their 3 specs each; 9 primary
  professions; 3 secondary professions (Cooking, Fishing, First Aid).
- Identity: a single shared guild passphrase gates the app. Members type a
  character name. No accounts.
- Edit rights: anyone past the passphrase can edit or delete any entry.
- Rules: none. No caps, no warnings. Coverage counts are informational.
- Hosting: one self-hosted Node service with SQLite, run via Docker.
- Stack: Node 22, TypeScript, Fastify, better-sqlite3, vanilla HTML/JS
  frontend with no build step.

## Architecture

```
wow/
  src/
    server.ts          # Fastify app factory + listen
    config.ts          # env parsing (PORT, DB_PATH, GUILD_PASSPHRASE, SESSION_SECRET)
    game-data.ts       # classes, specs, roles, professions (static)
    db.ts              # open SQLite, run schema, typed queries
    validate.ts        # pure validation of a member payload
    routes/auth.ts     # login/logout
    routes/members.ts  # CRUD
  public/
    index.html, app.js, style.css
  test/                # node:test + tsx
  Dockerfile, docker-compose.yml
```

The server serves `public/` statically and a JSON API under `/api`. Game
data lives in `src/game-data.ts`, is used by the validator on the server,
and is shipped to the client via `GET /api/game-data` so there is one source
of truth.

## Auth

- `POST /api/login { passphrase }` compares against `GUILD_PASSPHRASE` with
  a constant-time comparison. On success it sets a signed, HTTP-only,
  SameSite=Lax session cookie via `@fastify/cookie`. Cookie value is a random
  token; the signature uses `SESSION_SECRET` (required env var).
- `POST /api/logout` clears the cookie.
- Every `/api/*` route except `GET /api/game-data` and `POST /api/login`
  requires a valid signed cookie, else 401 `{ error: "unauthorized" }`.
- Sessions are stateless (signed cookie only). Rotating `SESSION_SECRET`
  logs everyone out.
- `POST /api/login` is rate-limited to 10 attempts per minute per IP via
  @fastify/rate-limit.
- Cookie `secure` flag is controlled by `COOKIE_SECURE`; `TRUST_PROXY`
  enables proxy-aware client IPs.

## Data model

Table `members`:

| column                | type    | notes                                      |
|-----------------------|---------|--------------------------------------------|
| id                    | integer | primary key autoincrement                  |
| character_name        | text    | unique, case-insensitive (COLLATE NOCASE)  |
| main_class            | text    | class id                                   |
| main_spec             | text    | spec id belonging to main_class            |
| backup_class          | text    | nullable                                   |
| backup_spec           | text    | nullable; required if backup_class set     |
| primary_professions   | text    | JSON array, exactly 2 distinct primary ids |
| secondary_professions | text    | JSON array, 0..3 distinct secondary ids    |
| notes                 | text    | optional, max 280 chars                    |
| created_at            | text    | ISO-8601                                   |
| updated_at            | text    | ISO-8601                                   |

Validation rules (server side, pure function in `validate.ts`):

1. `characterName`: trimmed, 2..24 chars, letters only (Unicode letters allowed).
2. `mainClass` must be a known class id; `mainSpec` must be a spec of that class.
3. `backupClass` optional. If set, `backupSpec` is required and must belong to
   it. Backup may equal main class only when the spec differs.
4. `primaryProfessions`: exactly 2 distinct known primary ids.
5. `secondaryProfessions`: 0..3 distinct known secondary ids.
6. `notes`: optional string, max 280 chars after trim.

The validator returns `{ ok: true, value }` with a normalized payload or
`{ ok: false, errors: string[] }`.

## API

| method | path                | body / result                                   |
|--------|---------------------|-------------------------------------------------|
| GET    | /api/game-data      | `{ classes, professions }`                      |
| POST   | /api/login          | `{ passphrase }` → 204 / 401                    |
| POST   | /api/logout         | 204                                             |
| GET    | /api/members        | `Member[]` sorted by character name             |
| POST   | /api/members        | payload → 201 `Member`                          |
| PUT    | /api/members/:id    | payload → 200 `Member`                          |
| DELETE | /api/members/:id    | 204                                             |

Errors: `{ error: string, details?: string[] }`. 400 validation, 401 no
session, 404 unknown id, 409 duplicate character name.

Member JSON shape uses camelCase: `id, characterName, mainClass, mainSpec,
backupClass, backupSpec, primaryProfessions, secondaryProfessions, notes,
createdAt, updatedAt`.

## UI

Single page, three regions:

1. **Gate panel.** Shown when no session. One passphrase field and an
   "Enter the Guild Hall" button. On 401 shows an inline error.
2. **Roster.** Coverage strip on top: counts of Tank / Healer / DPS across
   mains, and counts per primary profession across all members. Below, a
   table: character name, main (class color + spec + role badge), backup
   (same, or em dash), primaries, secondaries, notes, Edit / Delete.
   Delete asks for confirmation with an in-page dialog, never
   `window.confirm`.
3. **Form drawer.** Slides in for Add / Edit. Class select drives the spec
   select. Backup class select includes "None". Two primary selects,
   secondary checkboxes, notes textarea. Server errors render as a list
   above the submit button.

### WoW aesthetic (required)

- Palette: near-black stone background (`#0b0a08`), dark parchment panels
  (`#1c1710` to `#2a2318`), gold accents (`#c8aa6e`, highlight `#f0d78c`),
  muted parchment text (`#e8dcc0`). Danger red `#a33`.
- Class colors are the official WoW class palette (Warrior `#C69B6D`,
  Paladin `#F48CBA`, Hunter `#AAD372`, Rogue `#FFF468`, Priest `#FFFFFF`,
  Shaman `#0070DD`, Mage `#3FC7EB`, Warlock `#8788EE`, Druid `#FF7C0A`).
- Typography: Cinzel (Google Fonts) for headings and buttons, a readable
  serif (Crimson Text) for body. Small caps on table headers.
- Panels have a double gold border with beveled corner ornaments done in
  CSS (no image assets). Buttons look like the classic red/gold WoW button:
  dark gradient, gold border, glow on hover.
- Role badges use icon glyphs (shield, cross, swords) drawn as inline SVG.
- Subtle vignette on the page edges. No parallax, no animations beyond
  150ms hover transitions.
- Layout is responsive: table collapses to stacked cards under 720px.
- Respect `prefers-reduced-motion`.

## Error handling

- All route handlers wrap DB calls; unexpected errors log and return 500
  `{ error: "internal" }` without leaking details.
- SQLite UNIQUE violation on `character_name` maps to 409.
- Missing `GUILD_PASSPHRASE` or `SESSION_SECRET` fails startup with a clear
  message.
- Unknown routes return 404 `{ error: "not found" }`; other 4xx from the
  framework (413, 415, malformed JSON) keep their status with an
  `{ error }` body.

## Testing

- `test/validate.test.ts`: every rule above, valid and invalid cases.
- `test/api.test.ts`: Fastify `inject` against a temp DB file. Covers login
  success/failure, 401 gate, create/list/update/delete, 409 duplicate,
  400 invalid spec for class, 404 unknown id.
- `test/game-data.test.ts`: 9 classes, 27 specs, 9 primaries, 3 secondaries,
  every spec has a role.
- Runner: `node --test` via `tsx`. No browser tests.

## Deployment

- `Dockerfile`: node:22-bookworm-slim (glibc, so better-sqlite3 prebuilt binaries work), `npm ci`, `tsc`, run `dist/server.js`.
- `docker-compose.yml`: one service, env from `.env`, volume `./data:/data`,
  `DB_PATH=/data/roster.db`.
- `.env.example` lists the required vars (GUILD_PASSPHRASE, SESSION_SECRET)
  and optional ones (PORT, DB_PATH, COOKIE_SECURE, TRUST_PROXY).

## Out of scope

Discord login, officer roles, caps or warnings, per-alt professions, raid
composition planning, audit history, image assets.

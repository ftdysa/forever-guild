# WoW Forever Guild Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single self-hosted web app where guild members claim a main class, a backup class, and professions, shown on a shared roster with coverage counts.

**Architecture:** One Fastify (TypeScript) service serves a static vanilla-JS page and a JSON API under `/api`. Data is one `members` table in SQLite via better-sqlite3. Game data (classes, specs, roles, professions) is a static TS module used by server-side validation and shipped to the browser via `GET /api/game-data`.

**Tech Stack:** Node 20+ (Docker uses 22), TypeScript 5, Fastify 5, @fastify/cookie, @fastify/static, better-sqlite3, tsx + `node --test`, vanilla HTML/CSS/JS, Google Fonts (Cinzel, Crimson Text).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-14-guild-roster-design.md`. Read it before starting.
- Node >= 20. ESM throughout (`"type": "module"`). Import local files with `.js` extension in TS source.
- Required env vars: `GUILD_PASSPHRASE`, `SESSION_SECRET`. Optional: `PORT` (default 3000), `DB_PATH` (default `./data/roster.db`).
- API error body is always `{ error: string, details?: string[] }`. Codes: 400 validation, 401 no session, 404 unknown id, 409 duplicate name, 500 internal.
- Member JSON is camelCase: `id, characterName, mainClass, mainSpec, backupClass, backupSpec, primaryProfessions, secondaryProfessions, notes, createdAt, updatedAt`.
- No `window.confirm` / `alert` in the frontend. No image assets. No frontend build step.
- Class colors: Warrior `#C69B6D`, Paladin `#F48CBA`, Hunter `#AAD372`, Rogue `#FFF468`, Priest `#FFFFFF`, Shaman `#0070DD`, Mage `#3FC7EB`, Warlock `#8788EE`, Druid `#FF7C0A`.
- Palette: bg `#0b0a08`, panel `#1c1710`→`#2a2318`, gold `#c8aa6e`, gold highlight `#f0d78c`, text `#e8dcc0`, danger `#a33`.
- Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm test` before every commit. All tests must pass.

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore`, `.env.example` | project scaffold |
| `src/game-data.ts` | static classes/specs/roles/professions + lookup helpers |
| `src/validate.ts` | pure `validateMember(input)` → normalized value or errors |
| `src/config.ts` | `loadConfig(env)` with required-var checks |
| `src/db.ts` | `MemberStore` class: schema + typed CRUD over better-sqlite3 |
| `src/app.ts` | `buildApp(config)` Fastify factory: cookies, static, auth hook, routes |
| `src/routes/auth.ts` | login / logout |
| `src/routes/members.ts` | members CRUD |
| `src/server.ts` | entrypoint: load config, build app, listen |
| `public/index.html`, `public/style.css`, `public/app.js` | frontend |
| `test/*.test.ts` | node:test suites |
| `Dockerfile`, `docker-compose.yml`, `README.md` | deployment |

---

### Task 1: Scaffold and game data

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- Create: `src/game-data.ts`
- Test: `test/game-data.test.ts`

**Interfaces:**
- Produces: `CLASSES: GameClass[]`, `PROFESSIONS: Profession[]`, `PRIMARY_IDS: string[]`, `SECONDARY_IDS: string[]`, `findClass(id)`, `findSpec(classId, specId)`, `gameData()`; types `Role`, `Spec`, `GameClass`, `Profession`.

- [ ] **Step 1: Create scaffold files**

`package.json`:
```json
{
  "name": "wow-forever-guild-roster",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "node --import tsx --test test/*.test.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/static": "^8.1.1",
    "better-sqlite3": "^11.8.1",
    "fastify": "^5.2.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^20.17.0",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`.gitignore`:
```
node_modules/
dist/
data/
.env
```

`.env.example`:
```
GUILD_PASSPHRASE=change-me
SESSION_SECRET=generate-a-long-random-string
PORT=3000
DB_PATH=./data/roster.db
```

Run: `npm install`
Expected: `node_modules/` created, no errors (better-sqlite3 uses a prebuilt binary; if it compiles from source that is also fine).

- [ ] **Step 2: Write the failing test**

`test/game-data.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSES,
  PROFESSIONS,
  PRIMARY_IDS,
  SECONDARY_IDS,
  findClass,
  findSpec,
  gameData,
} from "../src/game-data.js";

test("has 9 classes with 3 specs each and a role on every spec", () => {
  assert.equal(CLASSES.length, 9);
  for (const c of CLASSES) {
    assert.equal(c.specs.length, 3, `${c.id} should have 3 specs`);
    assert.match(c.color, /^#[0-9A-F]{6}$/i);
    for (const s of c.specs) {
      assert.ok(["tank", "healer", "dps"].includes(s.role), `${c.id}/${s.id}`);
    }
  }
});

test("has 9 primary and 3 secondary professions", () => {
  assert.equal(PRIMARY_IDS.length, 9);
  assert.equal(SECONDARY_IDS.length, 3);
  assert.equal(PROFESSIONS.length, 12);
  assert.deepEqual(SECONDARY_IDS, ["cooking", "fishing", "first-aid"]);
});

test("class and spec ids are unique within scope", () => {
  const classIds = new Set(CLASSES.map((c) => c.id));
  assert.equal(classIds.size, 9);
  for (const c of CLASSES) {
    assert.equal(new Set(c.specs.map((s) => s.id)).size, 3);
  }
});

test("findClass / findSpec", () => {
  assert.equal(findClass("warrior")?.name, "Warrior");
  assert.equal(findClass("nope"), undefined);
  assert.equal(findSpec("warrior", "protection")?.role, "tank");
  assert.equal(findSpec("priest", "protection"), undefined);
  assert.equal(findSpec("nope", "protection"), undefined);
});

test("gameData returns classes and professions", () => {
  const d = gameData();
  assert.equal(d.classes.length, 9);
  assert.equal(d.professions.length, 12);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, cannot find module `../src/game-data.js`.

- [ ] **Step 4: Implement game data**

`src/game-data.ts`:
```ts
export type Role = "tank" | "healer" | "dps";

export interface Spec {
  id: string;
  name: string;
  role: Role;
}

export interface GameClass {
  id: string;
  name: string;
  color: string;
  specs: Spec[];
}

export interface Profession {
  id: string;
  name: string;
  kind: "primary" | "secondary";
}

const spec = (id: string, name: string, role: Role): Spec => ({ id, name, role });

export const CLASSES: GameClass[] = [
  {
    id: "warrior",
    name: "Warrior",
    color: "#C69B6D",
    specs: [spec("arms", "Arms", "dps"), spec("fury", "Fury", "dps"), spec("protection", "Protection", "tank")],
  },
  {
    id: "paladin",
    name: "Paladin",
    color: "#F48CBA",
    specs: [spec("holy", "Holy", "healer"), spec("protection", "Protection", "tank"), spec("retribution", "Retribution", "dps")],
  },
  {
    id: "hunter",
    name: "Hunter",
    color: "#AAD372",
    specs: [spec("beast-mastery", "Beast Mastery", "dps"), spec("marksmanship", "Marksmanship", "dps"), spec("survival", "Survival", "dps")],
  },
  {
    id: "rogue",
    name: "Rogue",
    color: "#FFF468",
    specs: [spec("assassination", "Assassination", "dps"), spec("combat", "Combat", "dps"), spec("subtlety", "Subtlety", "dps")],
  },
  {
    id: "priest",
    name: "Priest",
    color: "#FFFFFF",
    specs: [spec("discipline", "Discipline", "healer"), spec("holy", "Holy", "healer"), spec("shadow", "Shadow", "dps")],
  },
  {
    id: "shaman",
    name: "Shaman",
    color: "#0070DD",
    specs: [spec("elemental", "Elemental", "dps"), spec("enhancement", "Enhancement", "dps"), spec("restoration", "Restoration", "healer")],
  },
  {
    id: "mage",
    name: "Mage",
    color: "#3FC7EB",
    specs: [spec("arcane", "Arcane", "dps"), spec("fire", "Fire", "dps"), spec("frost", "Frost", "dps")],
  },
  {
    id: "warlock",
    name: "Warlock",
    color: "#8788EE",
    specs: [spec("affliction", "Affliction", "dps"), spec("demonology", "Demonology", "dps"), spec("destruction", "Destruction", "dps")],
  },
  {
    id: "druid",
    name: "Druid",
    color: "#FF7C0A",
    specs: [spec("balance", "Balance", "dps"), spec("feral-combat", "Feral Combat", "tank"), spec("restoration", "Restoration", "healer")],
  },
];

export const PROFESSIONS: Profession[] = [
  { id: "alchemy", name: "Alchemy", kind: "primary" },
  { id: "blacksmithing", name: "Blacksmithing", kind: "primary" },
  { id: "enchanting", name: "Enchanting", kind: "primary" },
  { id: "engineering", name: "Engineering", kind: "primary" },
  { id: "herbalism", name: "Herbalism", kind: "primary" },
  { id: "leatherworking", name: "Leatherworking", kind: "primary" },
  { id: "mining", name: "Mining", kind: "primary" },
  { id: "skinning", name: "Skinning", kind: "primary" },
  { id: "tailoring", name: "Tailoring", kind: "primary" },
  { id: "cooking", name: "Cooking", kind: "secondary" },
  { id: "fishing", name: "Fishing", kind: "secondary" },
  { id: "first-aid", name: "First Aid", kind: "secondary" },
];

export const PRIMARY_IDS: string[] = PROFESSIONS.filter((p) => p.kind === "primary").map((p) => p.id);
export const SECONDARY_IDS: string[] = PROFESSIONS.filter((p) => p.kind === "secondary").map((p) => p.id);

export function findClass(id: string): GameClass | undefined {
  return CLASSES.find((c) => c.id === id);
}

export function findSpec(classId: string, specId: string): Spec | undefined {
  return findClass(classId)?.specs.find((s) => s.id === specId);
}

export function gameData(): { classes: GameClass[]; professions: Profession[] } {
  return { classes: CLASSES, professions: PROFESSIONS };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: 5 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example src/game-data.ts test/game-data.test.ts
git commit -m "feat: scaffold project and add classic WoW game data

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Member validator

**Files:**
- Create: `src/validate.ts`
- Test: `test/validate.test.ts`

**Interfaces:**
- Consumes: `findClass`, `findSpec`, `PRIMARY_IDS`, `SECONDARY_IDS` from `src/game-data.ts`.
- Produces:
  ```ts
  export interface MemberInput {
    characterName: string; mainClass: string; mainSpec: string;
    backupClass: string | null; backupSpec: string | null;
    primaryProfessions: string[]; secondaryProfessions: string[]; notes: string;
  }
  export type ValidationResult = { ok: true; value: MemberInput } | { ok: false; errors: string[] };
  export function validateMember(input: unknown): ValidationResult;
  ```

- [ ] **Step 1: Write the failing tests**

`test/validate.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMember } from "../src/validate.js";

const good = {
  characterName: "  Thrall ",
  mainClass: "shaman",
  mainSpec: "restoration",
  backupClass: "warrior",
  backupSpec: "protection",
  primaryProfessions: ["alchemy", "herbalism"],
  secondaryProfessions: ["cooking", "first-aid"],
  notes: "  raid lead  ",
};

function errorsOf(input: unknown): string[] {
  const r = validateMember(input);
  return r.ok ? [] : r.errors;
}

test("accepts a valid payload and normalizes it", () => {
  const r = validateMember(good);
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    characterName: "Thrall",
    mainClass: "shaman",
    mainSpec: "restoration",
    backupClass: "warrior",
    backupSpec: "protection",
    primaryProfessions: ["alchemy", "herbalism"],
    secondaryProfessions: ["cooking", "first-aid"],
    notes: "raid lead",
  });
});

test("accepts no backup and no secondaries and missing notes", () => {
  const r = validateMember({ ...good, backupClass: null, backupSpec: null, secondaryProfessions: [], notes: undefined });
  assert.ok(r.ok);
  assert.equal(r.value.backupClass, null);
  assert.equal(r.value.backupSpec, null);
  assert.deepEqual(r.value.secondaryProfessions, []);
  assert.equal(r.value.notes, "");
});

test("rejects non-object input", () => {
  assert.deepEqual(errorsOf(null), ["payload must be an object"]);
  assert.deepEqual(errorsOf("x"), ["payload must be an object"]);
});

test("character name rules", () => {
  assert.ok(errorsOf({ ...good, characterName: "A" }).includes("characterName must be 2-24 letters"));
  assert.ok(errorsOf({ ...good, characterName: "A".repeat(25) }).includes("characterName must be 2-24 letters"));
  assert.ok(errorsOf({ ...good, characterName: "Thr4ll" }).includes("characterName must be 2-24 letters"));
  assert.ok(errorsOf({ ...good, characterName: "Thr all" }).includes("characterName must be 2-24 letters"));
  assert.ok(errorsOf({ ...good, characterName: 7 }).includes("characterName must be 2-24 letters"));
  assert.ok(validateMember({ ...good, characterName: "Ælfwynn" }).ok);
});

test("main class and spec rules", () => {
  assert.ok(errorsOf({ ...good, mainClass: "necromancer" }).includes("mainClass is not a known class"));
  assert.ok(errorsOf({ ...good, mainSpec: "protection" }).includes("mainSpec does not belong to mainClass"));
  assert.ok(errorsOf({ ...good, mainSpec: 3 }).includes("mainSpec does not belong to mainClass"));
});

test("backup rules", () => {
  assert.ok(errorsOf({ ...good, backupClass: "necromancer" }).includes("backupClass is not a known class"));
  assert.ok(errorsOf({ ...good, backupClass: "warrior", backupSpec: null }).includes("backupSpec is required when backupClass is set"));
  assert.ok(errorsOf({ ...good, backupClass: "warrior", backupSpec: "holy" }).includes("backupSpec does not belong to backupClass"));
  assert.ok(errorsOf({ ...good, backupClass: "shaman", backupSpec: "restoration" }).includes("backup cannot be the same class and spec as main"));
  assert.ok(validateMember({ ...good, backupClass: "shaman", backupSpec: "elemental" }).ok);
  // backupSpec without backupClass is ignored (normalized to null)
  const r = validateMember({ ...good, backupClass: null, backupSpec: "holy" });
  assert.ok(r.ok);
  assert.equal(r.value.backupSpec, null);
});

test("primary profession rules", () => {
  assert.ok(errorsOf({ ...good, primaryProfessions: ["alchemy"] }).includes("primaryProfessions must be exactly 2 distinct primary professions"));
  assert.ok(errorsOf({ ...good, primaryProfessions: ["alchemy", "alchemy"] }).includes("primaryProfessions must be exactly 2 distinct primary professions"));
  assert.ok(errorsOf({ ...good, primaryProfessions: ["alchemy", "cooking"] }).includes("primaryProfessions must be exactly 2 distinct primary professions"));
  assert.ok(errorsOf({ ...good, primaryProfessions: "alchemy" }).includes("primaryProfessions must be exactly 2 distinct primary professions"));
});

test("secondary profession rules", () => {
  assert.ok(errorsOf({ ...good, secondaryProfessions: ["cooking", "cooking"] }).includes("secondaryProfessions must be distinct secondary professions"));
  assert.ok(errorsOf({ ...good, secondaryProfessions: ["alchemy"] }).includes("secondaryProfessions must be distinct secondary professions"));
  assert.ok(errorsOf({ ...good, secondaryProfessions: "cooking" }).includes("secondaryProfessions must be distinct secondary professions"));
  assert.ok(validateMember({ ...good, secondaryProfessions: undefined }).ok);
});

test("notes rules", () => {
  assert.ok(errorsOf({ ...good, notes: "x".repeat(281) }).includes("notes must be at most 280 characters"));
  assert.ok(errorsOf({ ...good, notes: 5 }).includes("notes must be at most 280 characters"));
});

test("collects multiple errors at once", () => {
  const errs = errorsOf({ ...good, characterName: "", mainClass: "x", primaryProfessions: [] });
  assert.ok(errs.length >= 3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: validate tests FAIL, cannot find module `../src/validate.js`.

- [ ] **Step 3: Implement the validator**

`src/validate.ts`:
```ts
import { findClass, findSpec, PRIMARY_IDS, SECONDARY_IDS } from "./game-data.js";

export interface MemberInput {
  characterName: string;
  mainClass: string;
  mainSpec: string;
  backupClass: string | null;
  backupSpec: string | null;
  primaryProfessions: string[];
  secondaryProfessions: string[];
  notes: string;
}

export type ValidationResult = { ok: true; value: MemberInput } | { ok: false; errors: string[] };

const NAME_RE = /^\p{L}{2,24}$/u;
const NOTES_MAX = 280;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function distinct(arr: string[]): boolean {
  return new Set(arr).size === arr.length;
}

export function validateMember(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  const characterName = typeof raw.characterName === "string" ? raw.characterName.trim() : "";
  if (!NAME_RE.test(characterName)) errors.push("characterName must be 2-24 letters");

  const mainClass = typeof raw.mainClass === "string" ? raw.mainClass : "";
  const mainSpec = typeof raw.mainSpec === "string" ? raw.mainSpec : "";
  if (!findClass(mainClass)) errors.push("mainClass is not a known class");
  else if (!findSpec(mainClass, mainSpec)) errors.push("mainSpec does not belong to mainClass");

  let backupClass: string | null = typeof raw.backupClass === "string" && raw.backupClass !== "" ? raw.backupClass : null;
  let backupSpec: string | null = typeof raw.backupSpec === "string" && raw.backupSpec !== "" ? raw.backupSpec : null;
  if (backupClass === null) {
    backupSpec = null;
  } else if (!findClass(backupClass)) {
    errors.push("backupClass is not a known class");
  } else if (backupSpec === null) {
    errors.push("backupSpec is required when backupClass is set");
  } else if (!findSpec(backupClass, backupSpec)) {
    errors.push("backupSpec does not belong to backupClass");
  } else if (backupClass === mainClass && backupSpec === mainSpec) {
    errors.push("backup cannot be the same class and spec as main");
  }

  const primaryProfessions = isStringArray(raw.primaryProfessions) ? raw.primaryProfessions : null;
  if (
    !primaryProfessions ||
    primaryProfessions.length !== 2 ||
    !distinct(primaryProfessions) ||
    !primaryProfessions.every((p) => PRIMARY_IDS.includes(p))
  ) {
    errors.push("primaryProfessions must be exactly 2 distinct primary professions");
  }

  const secondaryRaw = raw.secondaryProfessions === undefined ? [] : raw.secondaryProfessions;
  const secondaryProfessions = isStringArray(secondaryRaw) ? secondaryRaw : null;
  if (!secondaryProfessions || !distinct(secondaryProfessions) || !secondaryProfessions.every((p) => SECONDARY_IDS.includes(p))) {
    errors.push("secondaryProfessions must be distinct secondary professions");
  }

  let notes = "";
  if (raw.notes !== undefined && raw.notes !== null) {
    if (typeof raw.notes !== "string") errors.push("notes must be at most 280 characters");
    else {
      notes = raw.notes.trim();
      if (notes.length > NOTES_MAX) errors.push("notes must be at most 280 characters");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      characterName,
      mainClass,
      mainSpec,
      backupClass,
      backupSpec,
      primaryProfessions: primaryProfessions as string[],
      secondaryProfessions: secondaryProfessions as string[],
      notes,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all passing (5 game-data + 10 validate).

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts test/validate.test.ts
git commit -m "feat: add member payload validator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Config and SQLite member store

**Files:**
- Create: `src/config.ts`, `src/db.ts`
- Test: `test/config.test.ts`, `test/db.test.ts`

**Interfaces:**
- Consumes: `MemberInput` from `src/validate.ts`.
- Produces:
  ```ts
  // config.ts
  export interface Config { port: number; dbPath: string; guildPassphrase: string; sessionSecret: string }
  export function loadConfig(env?: NodeJS.ProcessEnv): Config; // throws Error listing missing vars
  // db.ts
  export interface Member extends MemberInput { id: number; createdAt: string; updatedAt: string }
  export class DuplicateNameError extends Error {}
  export class MemberStore {
    constructor(dbPath: string); // ":memory:" allowed
    list(): Member[]; get(id: number): Member | undefined;
    create(input: MemberInput): Member; update(id: number, input: MemberInput): Member | undefined;
    delete(id: number): boolean; close(): void;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loads with defaults", () => {
  const c = loadConfig({ GUILD_PASSPHRASE: "pw", SESSION_SECRET: "s".repeat(32) });
  assert.equal(c.port, 3000);
  assert.equal(c.dbPath, "./data/roster.db");
  assert.equal(c.guildPassphrase, "pw");
});

test("honours PORT and DB_PATH", () => {
  const c = loadConfig({ GUILD_PASSPHRASE: "pw", SESSION_SECRET: "s".repeat(32), PORT: "8080", DB_PATH: ":memory:" });
  assert.equal(c.port, 8080);
  assert.equal(c.dbPath, ":memory:");
});

test("throws listing missing vars", () => {
  assert.throws(() => loadConfig({}), /GUILD_PASSPHRASE, SESSION_SECRET/);
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: "pw" }), /SESSION_SECRET/);
});

test("rejects short SESSION_SECRET and bad PORT", () => {
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: "pw", SESSION_SECRET: "short" }), /SESSION_SECRET must be at least 32 characters/);
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: "pw", SESSION_SECRET: "s".repeat(32), PORT: "abc" }), /PORT must be a number/);
});
```

`test/db.test.ts`:
```ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemberStore, DuplicateNameError } from "../src/db.js";
import type { MemberInput } from "../src/validate.js";

const thrall: MemberInput = {
  characterName: "Thrall",
  mainClass: "shaman",
  mainSpec: "restoration",
  backupClass: null,
  backupSpec: null,
  primaryProfessions: ["alchemy", "herbalism"],
  secondaryProfessions: ["cooking"],
  notes: "",
};

const jaina: MemberInput = {
  characterName: "Jaina",
  mainClass: "mage",
  mainSpec: "frost",
  backupClass: "priest",
  backupSpec: "holy",
  primaryProfessions: ["tailoring", "enchanting"],
  secondaryProfessions: [],
  notes: "portals",
};

let store: MemberStore;
beforeEach(() => {
  store = new MemberStore(":memory:");
});
afterEach(() => store.close());

test("create returns a member with id and timestamps, list is sorted by name", () => {
  const t = store.create(thrall);
  const j = store.create(jaina);
  assert.equal(typeof t.id, "number");
  assert.match(t.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(t.createdAt, t.updatedAt);
  assert.deepEqual(t.primaryProfessions, ["alchemy", "herbalism"]);
  assert.equal(j.backupSpec, "holy");
  assert.deepEqual(store.list().map((m) => m.characterName), ["Jaina", "Thrall"]);
});

test("get returns undefined for unknown id", () => {
  assert.equal(store.get(999), undefined);
});

test("duplicate name is rejected case-insensitively", () => {
  store.create(thrall);
  assert.throws(() => store.create({ ...thrall, characterName: "THRALL" }), DuplicateNameError);
});

test("update replaces fields and bumps updatedAt; keeps createdAt", async () => {
  const t = store.create(thrall);
  await new Promise((r) => setTimeout(r, 5));
  const u = store.update(t.id, { ...thrall, mainSpec: "elemental", notes: "zap" });
  assert.ok(u);
  assert.equal(u.mainSpec, "elemental");
  assert.equal(u.notes, "zap");
  assert.equal(u.createdAt, t.createdAt);
  assert.notEqual(u.updatedAt, t.updatedAt);
  assert.equal(store.update(999, thrall), undefined);
});

test("update to another member's name is rejected", () => {
  const t = store.create(thrall);
  store.create(jaina);
  assert.throws(() => store.update(t.id, { ...thrall, characterName: "jaina" }), DuplicateNameError);
  // renaming to own name with different case is fine
  assert.ok(store.update(t.id, { ...thrall, characterName: "THRALL" }));
});

test("delete returns true then false", () => {
  const t = store.create(thrall);
  assert.equal(store.delete(t.id), true);
  assert.equal(store.delete(t.id), false);
  assert.equal(store.list().length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: config and db tests FAIL with cannot find module.

- [ ] **Step 3: Implement config**

`src/config.ts`:
```ts
export interface Config {
  port: number;
  dbPath: string;
  guildPassphrase: string;
  sessionSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["GUILD_PASSPHRASE", "SESSION_SECRET"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  const sessionSecret = env.SESSION_SECRET as string;
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  const portRaw = env.PORT ?? "3000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a number");
  }
  return {
    port,
    dbPath: env.DB_PATH || "./data/roster.db",
    guildPassphrase: env.GUILD_PASSPHRASE as string,
    sessionSecret,
  };
}
```

- [ ] **Step 4: Implement the member store**

`src/db.ts`:
```ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemberInput } from "./validate.js";

export interface Member extends MemberInput {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export class DuplicateNameError extends Error {
  constructor() {
    super("character name already taken");
    this.name = "DuplicateNameError";
  }
}

interface Row {
  id: number;
  character_name: string;
  main_class: string;
  main_spec: string;
  backup_class: string | null;
  backup_spec: string | null;
  primary_professions: string;
  secondary_professions: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  main_class TEXT NOT NULL,
  main_spec TEXT NOT NULL,
  backup_class TEXT,
  backup_spec TEXT,
  primary_professions TEXT NOT NULL,
  secondary_professions TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

function rowToMember(r: Row): Member {
  return {
    id: r.id,
    characterName: r.character_name,
    mainClass: r.main_class,
    mainSpec: r.main_spec,
    backupClass: r.backup_class,
    backupSpec: r.backup_spec,
    primaryProfessions: JSON.parse(r.primary_professions) as string[],
    secondaryProfessions: JSON.parse(r.secondary_professions) as string[],
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

export class MemberStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  list(): Member[] {
    const rows = this.db.prepare("SELECT * FROM members ORDER BY character_name COLLATE NOCASE").all() as Row[];
    return rows.map(rowToMember);
  }

  get(id: number): Member | undefined {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToMember(row) : undefined;
  }

  create(input: MemberInput): Member {
    const now = new Date().toISOString();
    try {
      const info = this.db
        .prepare(
          `INSERT INTO members (character_name, main_class, main_spec, backup_class, backup_spec,
             primary_professions, secondary_professions, notes, created_at, updated_at)
           VALUES (@characterName, @mainClass, @mainSpec, @backupClass, @backupSpec,
             @primaryProfessions, @secondaryProfessions, @notes, @createdAt, @updatedAt)`,
        )
        .run({
          ...input,
          primaryProfessions: JSON.stringify(input.primaryProfessions),
          secondaryProfessions: JSON.stringify(input.secondaryProfessions),
          createdAt: now,
          updatedAt: now,
        });
      return this.get(Number(info.lastInsertRowid)) as Member;
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateNameError();
      throw err;
    }
  }

  update(id: number, input: MemberInput): Member | undefined {
    const now = new Date().toISOString();
    try {
      const info = this.db
        .prepare(
          `UPDATE members SET character_name = @characterName, main_class = @mainClass, main_spec = @mainSpec,
             backup_class = @backupClass, backup_spec = @backupSpec, primary_professions = @primaryProfessions,
             secondary_professions = @secondaryProfessions, notes = @notes, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          ...input,
          id,
          primaryProfessions: JSON.stringify(input.primaryProfessions),
          secondaryProfessions: JSON.stringify(input.secondaryProfessions),
          updatedAt: now,
        });
      if (info.changes === 0) return undefined;
      return this.get(id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateNameError();
      throw err;
    }
  }

  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM members WHERE id = ?").run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all passing. If the db test "update bumps updatedAt" flakes on identical ms timestamps, increase the sleep to 10ms.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/db.ts test/config.test.ts test/db.test.ts
git commit -m "feat: add config loader and SQLite member store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Fastify app, auth, and members API

**Files:**
- Create: `src/app.ts`, `src/routes/auth.ts`, `src/routes/members.ts`, `src/server.ts`
- Create: `public/index.html` (placeholder, replaced in Task 5)
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `Config` (`src/config.ts`), `MemberStore`, `DuplicateNameError` (`src/db.ts`), `validateMember` (`src/validate.ts`), `gameData` (`src/game-data.ts`).
- Produces: `buildApp(config: Config): FastifyInstance` with `app.store: MemberStore` decorated. Fastify `app.close()` closes the store.

- [ ] **Step 1: Write the failing tests**

`test/api.test.ts`:
```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const PASS = "for-the-horde";
const config = { port: 0, dbPath: ":memory:", guildPassphrase: PASS, sessionSecret: "x".repeat(40) };

const thrall = {
  characterName: "Thrall",
  mainClass: "shaman",
  mainSpec: "restoration",
  backupClass: "warrior",
  backupSpec: "protection",
  primaryProfessions: ["alchemy", "herbalism"],
  secondaryProfessions: ["cooking"],
  notes: "",
};

let app: FastifyInstance;
let cookie: { session: string };

before(async () => {
  app = buildApp(config);
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
  assert.equal(res.statusCode, 204);
  const c = res.cookies.find((x) => x.name === "session");
  assert.ok(c);
  cookie = { session: c.value };
});
after(async () => app.close());

test("game-data is public", async () => {
  const res = await app.inject({ method: "GET", url: "/api/game-data" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().classes.length, 9);
});

test("index.html is served", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/html/);
});

test("wrong passphrase is 401 and no cookie", async () => {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: "nope" } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "unauthorized" });
  assert.equal(res.cookies.length, 0);
});

test("missing passphrase is 400", async () => {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: {} });
  assert.equal(res.statusCode, 400);
});

test("members routes require session", async () => {
  for (const [method, url] of [
    ["GET", "/api/members"],
    ["POST", "/api/members"],
    ["PUT", "/api/members/1"],
    ["DELETE", "/api/members/1"],
  ] as const) {
    const res = await app.inject({ method, url, payload: method === "GET" || method === "DELETE" ? undefined : thrall });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  const forged = await app.inject({ method: "GET", url: "/api/members", cookies: { session: "forged.sig" } });
  assert.equal(forged.statusCode, 401);
});

test("create, list, update, delete", async () => {
  const created = await app.inject({ method: "POST", url: "/api/members", cookies: cookie, payload: thrall });
  assert.equal(created.statusCode, 201);
  const m = created.json();
  assert.equal(m.characterName, "Thrall");
  assert.equal(typeof m.id, "number");

  const list = await app.inject({ method: "GET", url: "/api/members", cookies: cookie });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);

  const updated = await app.inject({
    method: "PUT",
    url: `/api/members/${m.id}`,
    cookies: cookie,
    payload: { ...thrall, mainSpec: "elemental" },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().mainSpec, "elemental");

  const del = await app.inject({ method: "DELETE", url: `/api/members/${m.id}`, cookies: cookie });
  assert.equal(del.statusCode, 204);
  const again = await app.inject({ method: "DELETE", url: `/api/members/${m.id}`, cookies: cookie });
  assert.equal(again.statusCode, 404);
});

test("validation errors are 400 with details", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/members",
    cookies: cookie,
    payload: { ...thrall, mainSpec: "protection" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "validation failed");
  assert.ok(res.json().details.includes("mainSpec does not belong to mainClass"));
});

test("duplicate name is 409", async () => {
  const a = await app.inject({ method: "POST", url: "/api/members", cookies: cookie, payload: { ...thrall, characterName: "Jaina" } });
  assert.equal(a.statusCode, 201);
  const b = await app.inject({ method: "POST", url: "/api/members", cookies: cookie, payload: { ...thrall, characterName: "jaina" } });
  assert.equal(b.statusCode, 409);
  assert.deepEqual(b.json(), { error: "character name already taken" });
});

test("unknown id is 404, bad id is 400", async () => {
  const res = await app.inject({ method: "PUT", url: "/api/members/99999", cookies: cookie, payload: thrall });
  assert.equal(res.statusCode, 404);
  const bad = await app.inject({ method: "PUT", url: "/api/members/abc", cookies: cookie, payload: thrall });
  assert.equal(bad.statusCode, 400);
});

test("logout clears the cookie", async () => {
  const res = await app.inject({ method: "POST", url: "/api/logout", cookies: cookie });
  assert.equal(res.statusCode, 204);
  const c = res.cookies.find((x) => x.name === "session");
  assert.ok(c);
  assert.equal(c.value, "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: api tests FAIL, cannot find module `../src/app.js`.

- [ ] **Step 3: Implement auth routes**

`src/routes/auth.ts`:
```ts
import type { FastifyPluginCallback } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const authRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post<{ Body: { passphrase?: unknown } }>("/login", async (req, reply) => {
    const passphrase = req.body?.passphrase;
    if (typeof passphrase !== "string") {
      return reply.code(400).send({ error: "passphrase is required" });
    }
    if (!safeEqual(passphrase, app.config.guildPassphrase)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    reply.setCookie(SESSION_COOKIE, randomBytes(16).toString("hex"), {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return reply.code(204).send();
  });

  app.post("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  done();
};
```

- [ ] **Step 4: Implement members routes**

`src/routes/members.ts`:
```ts
import type { FastifyPluginCallback } from "fastify";
import { validateMember } from "../validate.js";
import { DuplicateNameError } from "../db.js";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export const memberRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/members", async () => app.store.list());

  app.post("/members", async (req, reply) => {
    const v = validateMember(req.body);
    if (!v.ok) return reply.code(400).send({ error: "validation failed", details: v.errors });
    try {
      return reply.code(201).send(app.store.create(v.value));
    } catch (err) {
      if (err instanceof DuplicateNameError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>("/members/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid id" });
    const v = validateMember(req.body);
    if (!v.ok) return reply.code(400).send({ error: "validation failed", details: v.errors });
    try {
      const updated = app.store.update(id, v.value);
      if (!updated) return reply.code(404).send({ error: "not found" });
      return updated;
    } catch (err) {
      if (err instanceof DuplicateNameError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/members/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid id" });
    if (!app.store.delete(id)) return reply.code(404).send({ error: "not found" });
    return reply.code(204).send();
  });

  done();
};
```

- [ ] **Step 5: Implement the app factory and entrypoint**

`src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { MemberStore } from "./db.js";
import { gameData } from "./game-data.js";
import { authRoutes, SESSION_COOKIE } from "./routes/auth.js";
import { memberRoutes } from "./routes/members.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    store: MemberStore;
  }
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" && process.env.LOG !== "off" });
  app.decorate("config", config);
  app.decorate("store", new MemberStore(config.dbPath));
  app.addHook("onClose", async () => app.store.close());

  app.register(fastifyCookie, { secret: config.sessionSecret });
  app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/" });

  app.setErrorHandler((err, _req, reply) => {
    if (err.validation || err.statusCode === 400) {
      return reply.code(400).send({ error: "bad request" });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  app.register(
    async (api) => {
      api.get("/game-data", async () => gameData());
      api.register(authRoutes);
      api.register(async (secured) => {
        secured.addHook("onRequest", async (req, reply) => {
          const raw = req.cookies[SESSION_COOKIE];
          if (!raw) return reply.code(401).send({ error: "unauthorized" });
          const { valid } = req.unsignCookie(raw);
          if (!valid) return reply.code(401).send({ error: "unauthorized" });
        });
        secured.register(memberRoutes);
      });
    },
    { prefix: "/api" },
  );

  return app;
}
```

`src/server.ts`:
```ts
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = buildApp(config);

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

Placeholder `public/index.html` (Task 5 replaces it):
```html
<!doctype html><html><head><meta charset="utf-8"><title>WoW Forever Guild Roster</title></head><body>roster</body></html>
```

In `package.json` scripts, change `test` to set `NODE_ENV=test` so logs stay quiet:
```json
"test": "NODE_ENV=test node --import tsx --test test/*.test.ts"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: all passing (game-data 5, validate 10, config 4, db 6, api 10).

Then: `npm run typecheck` — Expected: no errors.

- [ ] **Step 7: Manual smoke**

Run: `GUILD_PASSPHRASE=pw SESSION_SECRET=$(head -c 48 /dev/urandom | base64) DB_PATH=:memory: npx tsx src/server.ts &` then
`curl -s localhost:3000/api/game-data | head -c 80` → JSON starting with `{"classes":[{"id":"warrior"`.
`curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/members` → `401`.
Kill the server.

- [ ] **Step 8: Commit**

```bash
git add src/app.ts src/routes/auth.ts src/routes/members.ts src/server.ts public/index.html package.json test/api.test.ts
git commit -m "feat: add Fastify app with passphrase auth and members API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Frontend with WoW aesthetic

**Files:**
- Replace: `public/index.html`
- Create: `public/style.css`, `public/app.js`
- Test: extend `test/api.test.ts` (static files served)

**Interfaces:**
- Consumes the API from Task 4 exactly as specified in Global Constraints.
- Produces: single page with gate panel, coverage strip, roster table (cards under 720px), add/edit drawer, in-page delete dialog.

- [ ] **Step 1: Add failing static-asset test**

Append to `test/api.test.ts`:
```ts
test("style.css and app.js are served", async () => {
  const css = await app.inject({ method: "GET", url: "/style.css" });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["content-type"] as string, /text\/css/);
  const js = await app.inject({ method: "GET", url: "/app.js" });
  assert.equal(js.statusCode, 200);
  assert.match(js.body, /api\/game-data/);
});
```

Run: `npm test` — Expected: that test FAILS with 404.

- [ ] **Step 2: Write `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WoW Forever Guild Roster</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header class="masthead">
    <h1>WoW Forever</h1>
    <p class="subtitle">Guild Roster &amp; Profession Ledger</p>
  </header>

  <main id="app">
    <!-- Gate -->
    <section id="gate" class="panel gate hidden">
      <h2>Guild Hall</h2>
      <p>Speak the guild passphrase to enter.</p>
      <form id="gate-form">
        <label>
          <span>Passphrase</span>
          <input id="gate-pass" type="password" autocomplete="current-password" required />
        </label>
        <p id="gate-error" class="error hidden" role="alert"></p>
        <button type="submit" class="btn">Enter the Guild Hall</button>
      </form>
    </section>

    <!-- Roster -->
    <section id="roster" class="hidden">
      <div class="toolbar">
        <button id="add-btn" class="btn">Add Member</button>
        <button id="logout-btn" class="btn btn-ghost">Leave Hall</button>
      </div>

      <section class="panel coverage" aria-label="Coverage">
        <h2>Coverage</h2>
        <div id="role-coverage" class="coverage-row"></div>
        <div id="prof-coverage" class="coverage-row"></div>
      </section>

      <section class="panel" aria-label="Roster">
        <h2>Roster</h2>
        <p id="empty-msg" class="muted hidden">No members yet. Be the first to sign the ledger.</p>
        <table id="roster-table" class="roster">
          <thead>
            <tr>
              <th>Character</th>
              <th>Main</th>
              <th>Backup</th>
              <th>Primaries</th>
              <th>Secondaries</th>
              <th>Notes</th>
              <th class="actions">Actions</th>
            </tr>
          </thead>
          <tbody id="roster-body"></tbody>
        </table>
      </section>
    </section>
  </main>

  <!-- Drawer -->
  <aside id="drawer" class="drawer hidden" aria-hidden="true">
    <div class="panel drawer-panel">
      <h2 id="drawer-title">Add Member</h2>
      <form id="member-form">
        <input type="hidden" id="f-id" />
        <label><span>Character name</span><input id="f-name" required maxlength="24" /></label>

        <fieldset>
          <legend>Main</legend>
          <label><span>Class</span><select id="f-main-class" required></select></label>
          <label><span>Spec</span><select id="f-main-spec" required></select></label>
        </fieldset>

        <fieldset>
          <legend>Backup</legend>
          <label><span>Class</span><select id="f-backup-class"></select></label>
          <label><span>Spec</span><select id="f-backup-spec"></select></label>
        </fieldset>

        <fieldset>
          <legend>Primary professions</legend>
          <label><span>First</span><select id="f-prim-1" required></select></label>
          <label><span>Second</span><select id="f-prim-2" required></select></label>
        </fieldset>

        <fieldset>
          <legend>Secondary professions</legend>
          <div id="f-secondaries" class="checks"></div>
        </fieldset>

        <label><span>Notes</span><textarea id="f-notes" maxlength="280" rows="3"></textarea></label>

        <ul id="form-errors" class="error hidden" role="alert"></ul>

        <div class="drawer-actions">
          <button type="button" id="cancel-btn" class="btn btn-ghost">Cancel</button>
          <button type="submit" class="btn">Save</button>
        </div>
      </form>
    </div>
  </aside>

  <!-- Delete dialog -->
  <dialog id="confirm" class="confirm">
    <div class="panel">
      <h2>Remove from roster?</h2>
      <p id="confirm-text"></p>
      <div class="drawer-actions">
        <button type="button" id="confirm-cancel" class="btn btn-ghost">Keep</button>
        <button type="button" id="confirm-ok" class="btn btn-danger">Remove</button>
      </div>
    </div>
  </dialog>

  <script src="/app.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 3: Write `public/style.css`**

```css
:root {
  --bg: #0b0a08;
  --panel: #1c1710;
  --panel-2: #2a2318;
  --gold: #c8aa6e;
  --gold-hi: #f0d78c;
  --gold-dim: #6b5a33;
  --text: #e8dcc0;
  --muted: #9c8f72;
  --danger: #a33;
  --font-head: "Cinzel", "Times New Roman", serif;
  --font-body: "Crimson Text", Georgia, serif;
}

* { box-sizing: border-box; }

html, body { margin: 0; min-height: 100%; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 18px;
  line-height: 1.45;
  padding: 0 16px 48px;
  position: relative;
}

/* vignette */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.75) 100%);
  z-index: 0;
}

body > * { position: relative; z-index: 1; }

.hidden { display: none !important; }
.muted { color: var(--muted); }

h1, h2, h3, legend, th, .btn {
  font-family: var(--font-head);
  letter-spacing: 0.04em;
}

.masthead { text-align: center; padding: 32px 0 16px; }
.masthead h1 {
  margin: 0;
  font-size: clamp(32px, 6vw, 56px);
  color: var(--gold-hi);
  text-shadow: 0 0 18px rgba(240, 215, 140, 0.35), 0 2px 0 #000;
}
.masthead .subtitle { margin: 4px 0 0; color: var(--gold); font-style: italic; }

/* Panels: double gold border with corner ornaments */
.panel {
  position: relative;
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  border: 2px solid var(--gold);
  box-shadow:
    inset 0 0 0 1px #000,
    inset 0 0 0 4px var(--gold-dim),
    0 0 0 1px #000,
    0 8px 24px rgba(0, 0, 0, 0.6);
  padding: 20px;
  margin: 0 auto 20px;
  max-width: 1100px;
}
.panel::before, .panel::after {
  content: "";
  position: absolute;
  width: 14px; height: 14px;
  background: var(--gold);
  transform: rotate(45deg);
  box-shadow: 0 0 0 2px #000;
}
.panel::before { top: -8px; left: -8px; }
.panel::after { bottom: -8px; right: -8px; }
.panel h2 {
  margin: 0 0 12px;
  color: var(--gold-hi);
  font-size: 22px;
  border-bottom: 1px solid var(--gold-dim);
  padding-bottom: 6px;
}

/* Buttons: classic red/gold */
.btn {
  cursor: pointer;
  color: var(--gold-hi);
  background: linear-gradient(180deg, #4a1010, #1a0505);
  border: 2px solid var(--gold);
  box-shadow: inset 0 0 0 1px #000, 0 0 0 1px #000;
  padding: 8px 18px;
  font-size: 15px;
  text-transform: uppercase;
  transition: box-shadow 150ms, filter 150ms;
}
.btn:hover, .btn:focus-visible {
  outline: none;
  filter: brightness(1.15);
  box-shadow: inset 0 0 0 1px #000, 0 0 0 1px #000, 0 0 12px rgba(240, 215, 140, 0.6);
}
.btn-ghost { background: linear-gradient(180deg, #2a2318, #14100a); }
.btn-danger { background: linear-gradient(180deg, #7a1a1a, #2a0606); }
.btn-small { padding: 4px 10px; font-size: 12px; }

/* Forms */
form label { display: block; margin: 10px 0; }
form label span { display: block; font-family: var(--font-head); font-size: 13px; color: var(--gold); margin-bottom: 4px; }
input, select, textarea {
  width: 100%;
  font: inherit;
  color: var(--text);
  background: #0f0d09;
  border: 1px solid var(--gold-dim);
  padding: 8px 10px;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--gold-hi); }
fieldset { border: 1px solid var(--gold-dim); margin: 12px 0; padding: 8px 12px 4px; }
legend { color: var(--gold); font-size: 13px; padding: 0 6px; }
.checks { display: flex; flex-wrap: wrap; gap: 12px; padding: 6px 0; }
.checks label { display: flex; align-items: center; gap: 6px; margin: 0; }
.checks input { width: auto; }
.error { color: #ff8a8a; margin: 8px 0; padding-left: 18px; }
ul.error { list-style: "✦ "; }
p.error { padding-left: 0; }

.gate { max-width: 440px; text-align: center; }
.gate form { text-align: left; }

.toolbar { max-width: 1100px; margin: 0 auto 16px; display: flex; gap: 10px; justify-content: flex-end; }

/* Coverage */
.coverage-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
.stat {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 4px 12px;
  border: 1px solid var(--gold-dim);
  background: #0f0d09;
  font-family: var(--font-head);
  font-size: 13px;
}
.stat b { color: var(--gold-hi); font-size: 16px; }
.stat svg { width: 16px; height: 16px; fill: var(--gold); }

/* Roster table */
.roster { width: 100%; border-collapse: collapse; }
.roster th {
  text-align: left;
  font-size: 12px;
  font-variant: small-caps;
  color: var(--gold);
  border-bottom: 1px solid var(--gold-dim);
  padding: 6px 8px;
}
.roster td { padding: 8px; border-bottom: 1px solid rgba(107, 90, 51, 0.35); vertical-align: top; }
.roster tr:hover td { background: rgba(200, 170, 110, 0.05); }
.roster .actions { text-align: right; white-space: nowrap; }
.cls { font-weight: 600; }
.spec { color: var(--muted); font-size: 15px; }
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-head); font-size: 11px;
  border: 1px solid var(--gold-dim); padding: 1px 6px; margin-left: 6px;
  vertical-align: middle;
}
.badge svg { width: 12px; height: 12px; fill: var(--gold); }
.name { font-family: var(--font-head); font-size: 17px; color: var(--gold-hi); }

/* Drawer */
.drawer {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex; justify-content: flex-end;
  z-index: 10;
}
.drawer-panel {
  width: min(520px, 100%);
  height: 100%;
  overflow-y: auto;
  margin: 0;
  border-top: 0; border-bottom: 0; border-right: 0;
}
.drawer-panel::before, .drawer-panel::after { display: none; }
.drawer-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }

/* Dialog */
dialog.confirm { border: 0; background: transparent; padding: 0; }
dialog.confirm::backdrop { background: rgba(0, 0, 0, 0.7); }
dialog.confirm .panel { margin: 0; min-width: min(420px, 90vw); }

/* Mobile: table to cards */
@media (max-width: 720px) {
  body { font-size: 16px; }
  .roster thead { display: none; }
  .roster tr { display: block; border: 1px solid var(--gold-dim); margin-bottom: 12px; padding: 8px; }
  .roster td { display: block; border: 0; padding: 4px 0; }
  .roster td::before {
    content: attr(data-label);
    display: block;
    font-family: var(--font-head);
    font-size: 11px;
    font-variant: small-caps;
    color: var(--gold);
  }
  .roster td.actions { text-align: left; }
  .roster td.actions::before { content: none; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
```

- [ ] **Step 4: Write `public/app.js`**

```js
const $ = (sel) => document.querySelector(sel);

const ICONS = {
  tank: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3z"/></svg>',
  healer: '<svg viewBox="0 0 24 24"><path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/></svg>',
  dps: '<svg viewBox="0 0 24 24"><path d="M3 3l6 1 9 9-2 2-9-9-1-6-3 3zm18 0 3 3-1 6-9 9-2-2 9-9 1-6-1-1zM5 17l2 2-3 3-2-2 3-3zm14 0 3 3-2 2-3-3 2-2z"/></svg>',
};
const ROLE_LABEL = { tank: "Tank", healer: "Healer", dps: "DPS" };

let game = null; // { classes, professions }
let members = [];
let pendingDeleteId = null;

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { ok: true, status: 204, data: null };
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { ok: res.ok, status: res.status, data };
}

// ---------- Helpers ----------
const classById = (id) => game.classes.find((c) => c.id === id);
const specOf = (classId, specId) => classById(classId)?.specs.find((s) => s.id === specId);
const profName = (id) => game.professions.find((p) => p.id === id)?.name ?? id;
const primaries = () => game.professions.filter((p) => p.kind === "primary");
const secondaries = () => game.professions.filter((p) => p.kind === "secondary");

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function classCell(classId, specId) {
  if (!classId) return '<span class="muted">—</span>';
  const c = classById(classId);
  const s = specOf(classId, specId);
  const badge = s ? `<span class="badge">${ICONS[s.role]}${ROLE_LABEL[s.role]}</span>` : "";
  return `<span class="cls" style="color:${c.color}">${esc(c.name)}</span>${badge}<br><span class="spec">${esc(s?.name ?? specId)}</span>`;
}

function fillSelect(sel, items, { placeholder } = {}) {
  sel.innerHTML = "";
  if (placeholder) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = placeholder;
    sel.appendChild(o);
  }
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it.id;
    o.textContent = it.name;
    sel.appendChild(o);
  }
}

function fillSpecs(classSel, specSel, { placeholder } = {}) {
  const c = classById(classSel.value);
  fillSelect(specSel, c ? c.specs : [], { placeholder });
  specSel.disabled = !c;
}

// ---------- Render ----------
function renderCoverage() {
  const roles = { tank: 0, healer: 0, dps: 0 };
  for (const m of members) {
    const s = specOf(m.mainClass, m.mainSpec);
    if (s) roles[s.role]++;
  }
  $("#role-coverage").innerHTML = Object.keys(roles)
    .map((r) => `<span class="stat">${ICONS[r]}${ROLE_LABEL[r]} <b>${roles[r]}</b></span>`)
    .join("");

  const profs = {};
  for (const p of primaries()) profs[p.id] = 0;
  for (const m of members) for (const p of m.primaryProfessions) if (p in profs) profs[p]++;
  $("#prof-coverage").innerHTML = primaries()
    .map((p) => `<span class="stat">${esc(p.name)} <b>${profs[p.id]}</b></span>`)
    .join("");
}

function renderRoster() {
  const body = $("#roster-body");
  $("#empty-msg").classList.toggle("hidden", members.length > 0);
  $("#roster-table").classList.toggle("hidden", members.length === 0);
  body.innerHTML = members
    .map(
      (m) => `
    <tr data-id="${m.id}">
      <td data-label="Character"><span class="name">${esc(m.characterName)}</span></td>
      <td data-label="Main">${classCell(m.mainClass, m.mainSpec)}</td>
      <td data-label="Backup">${classCell(m.backupClass, m.backupSpec)}</td>
      <td data-label="Primaries">${m.primaryProfessions.map((p) => esc(profName(p))).join(", ")}</td>
      <td data-label="Secondaries">${m.secondaryProfessions.length ? m.secondaryProfessions.map((p) => esc(profName(p))).join(", ") : '<span class="muted">—</span>'}</td>
      <td data-label="Notes">${m.notes ? esc(m.notes) : '<span class="muted">—</span>'}</td>
      <td class="actions">
        <button class="btn btn-ghost btn-small" data-action="edit">Edit</button>
        <button class="btn btn-danger btn-small" data-action="delete">Remove</button>
      </td>
    </tr>`,
    )
    .join("");
  renderCoverage();
}

function showGate(msg) {
  $("#gate").classList.remove("hidden");
  $("#roster").classList.add("hidden");
  const e = $("#gate-error");
  e.textContent = msg ?? "";
  e.classList.toggle("hidden", !msg);
}

function showRoster() {
  $("#gate").classList.add("hidden");
  $("#roster").classList.remove("hidden");
}

// ---------- Drawer ----------
function openDrawer(member) {
  $("#drawer-title").textContent = member ? "Edit Member" : "Add Member";
  $("#form-errors").classList.add("hidden");
  $("#form-errors").innerHTML = "";
  $("#f-id").value = member?.id ?? "";
  $("#f-name").value = member?.characterName ?? "";
  $("#f-main-class").value = member?.mainClass ?? game.classes[0].id;
  fillSpecs($("#f-main-class"), $("#f-main-spec"));
  $("#f-main-spec").value = member?.mainSpec ?? $("#f-main-spec").options[0].value;
  $("#f-backup-class").value = member?.backupClass ?? "";
  fillSpecs($("#f-backup-class"), $("#f-backup-spec"), { placeholder: "—" });
  $("#f-backup-spec").value = member?.backupSpec ?? "";
  $("#f-prim-1").value = member?.primaryProfessions[0] ?? primaries()[0].id;
  $("#f-prim-2").value = member?.primaryProfessions[1] ?? primaries()[1].id;
  for (const cb of document.querySelectorAll("#f-secondaries input")) {
    cb.checked = member?.secondaryProfessions.includes(cb.value) ?? false;
  }
  $("#f-notes").value = member?.notes ?? "";
  const d = $("#drawer");
  d.classList.remove("hidden");
  d.setAttribute("aria-hidden", "false");
  $("#f-name").focus();
}

function closeDrawer() {
  const d = $("#drawer");
  d.classList.add("hidden");
  d.setAttribute("aria-hidden", "true");
}

function formPayload() {
  return {
    characterName: $("#f-name").value,
    mainClass: $("#f-main-class").value,
    mainSpec: $("#f-main-spec").value,
    backupClass: $("#f-backup-class").value || null,
    backupSpec: $("#f-backup-spec").value || null,
    primaryProfessions: [$("#f-prim-1").value, $("#f-prim-2").value],
    secondaryProfessions: [...document.querySelectorAll("#f-secondaries input:checked")].map((cb) => cb.value),
    notes: $("#f-notes").value,
  };
}

function showFormErrors(list) {
  const ul = $("#form-errors");
  ul.innerHTML = list.map((e) => `<li>${esc(e)}</li>`).join("");
  ul.classList.remove("hidden");
}

// ---------- Data loading ----------
async function loadMembers() {
  const r = await api("GET", "/api/members");
  if (r.status === 401) {
    showGate();
    return false;
  }
  members = r.data ?? [];
  renderRoster();
  showRoster();
  return true;
}

function initForm() {
  fillSelect($("#f-main-class"), game.classes);
  fillSelect($("#f-backup-class"), game.classes, { placeholder: "None" });
  fillSelect($("#f-prim-1"), primaries());
  fillSelect($("#f-prim-2"), primaries());
  $("#f-secondaries").innerHTML = secondaries()
    .map((p) => `<label><input type="checkbox" value="${p.id}" /> ${esc(p.name)}</label>`)
    .join("");
  $("#f-main-class").addEventListener("change", () => fillSpecs($("#f-main-class"), $("#f-main-spec")));
  $("#f-backup-class").addEventListener("change", () => fillSpecs($("#f-backup-class"), $("#f-backup-spec"), { placeholder: "—" }));
}

// ---------- Events ----------
$("#gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await api("POST", "/api/login", { passphrase: $("#gate-pass").value });
  if (!r.ok) {
    showGate("The guild does not recognize that passphrase.");
    return;
  }
  $("#gate-pass").value = "";
  await loadMembers();
});

$("#logout-btn").addEventListener("click", async () => {
  await api("POST", "/api/logout");
  members = [];
  showGate();
});

$("#add-btn").addEventListener("click", () => openDrawer(null));
$("#cancel-btn").addEventListener("click", closeDrawer);
$("#drawer").addEventListener("click", (e) => {
  if (e.target === $("#drawer")) closeDrawer();
});

$("#member-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#f-id").value;
  const r = id ? await api("PUT", `/api/members/${id}`, formPayload()) : await api("POST", "/api/members", formPayload());
  if (r.status === 401) return showGate("Your session expired. Enter the passphrase again.");
  if (!r.ok) return showFormErrors(r.data?.details ?? [r.data?.error ?? "Something went wrong."]);
  closeDrawer();
  await loadMembers();
});

$("#roster-body").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.closest("tr").dataset.id);
  const m = members.find((x) => x.id === id);
  if (!m) return;
  if (btn.dataset.action === "edit") openDrawer(m);
  if (btn.dataset.action === "delete") {
    pendingDeleteId = id;
    $("#confirm-text").textContent = `${m.characterName} will be struck from the ledger.`;
    $("#confirm").showModal();
  }
});

$("#confirm-cancel").addEventListener("click", () => $("#confirm").close());
$("#confirm-ok").addEventListener("click", async () => {
  const id = pendingDeleteId;
  pendingDeleteId = null;
  $("#confirm").close();
  const r = await api("DELETE", `/api/members/${id}`);
  if (r.status === 401) return showGate("Your session expired. Enter the passphrase again.");
  await loadMembers();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#drawer").classList.contains("hidden")) closeDrawer();
});

// ---------- Boot ----------
(async function boot() {
  const r = await api("GET", "/api/game-data");
  game = r.data;
  initForm();
  await loadMembers();
})();
```

- [ ] **Step 5: Run tests**

Run: `npm test` — Expected: all passing including the new static-asset test.

- [ ] **Step 6: Manual browser check**

Run: `GUILD_PASSPHRASE=pw SESSION_SECRET=$(head -c 48 /dev/urandom | base64) DB_PATH=./data/dev.db npm run dev`
Open http://localhost:3000. Verify:
- Gate panel shows; wrong passphrase shows the inline error; `pw` enters.
- Add Member: changing Main class repopulates the spec select; Backup "None" disables its spec select.
- Submitting with both primaries equal shows the server error list in the drawer.
- Saved member appears with class color, role badge, and coverage counts update.
- Edit prefills; Remove opens the in-page dialog; Keep closes it; Remove deletes.
- Narrow window under 720px: table collapses to cards.
Stop the server.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/style.css public/app.js test/api.test.ts
git commit -m "feat: add roster frontend with WoW styling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Docker and README

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `README.md`

**Interfaces:**
- Consumes: `npm run build` → `dist/server.js`; `public/` served relative to `dist/..`.

- [ ] **Step 1: Write Docker files**

`Dockerfile`:
```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

`.dockerignore`:
```
node_modules
dist
data
.env
docs
test
.git
```

`docker-compose.yml`:
```yaml
services:
  roster:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    environment:
      DB_PATH: /data/roster.db
      PORT: "3000"
    volumes:
      - ./data:/data
    restart: unless-stopped
```

- [ ] **Step 2: Write README.md**

```markdown
# WoW Forever Guild Roster

Guild members claim a main class/spec, an optional backup class/spec, two
primary professions, and secondary professions. Everyone behind the guild
passphrase sees the full roster and coverage counts.

## Run with Docker

```bash
cp .env.example .env   # set GUILD_PASSPHRASE and a long random SESSION_SECRET
docker compose up -d --build
```

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

Errors: `{ error, details? }` with 400 / 401 / 404 / 409.

## Design

See `docs/superpowers/specs/2026-10-14-guild-roster-design.md`.
```

- [ ] **Step 3: Build and run the container**

Run: `docker compose build` — Expected: image builds without error.
Run:
```bash
printf 'GUILD_PASSPHRASE=pw\nSESSION_SECRET=%s\n' "$(head -c 48 /dev/urandom | base64 | tr -d '\n')" > .env
docker compose up -d
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/        # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/members  # 401
docker compose down
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml README.md
git commit -m "chore: add Docker packaging and README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

# Class Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Classes` tab showing a class → spec grid of who plays what (mains and backups).

**Architecture:** A pure grouping function lives in its own browser ES module
(`public/class-overview.js`) so it can be unit tested from Node. `app.js`
imports it, renders the grid into a new panel, and switches between Roster and
Classes tabs via `location.hash`. No server changes.

**Tech Stack:** Vanilla browser JS (no build step), CSS, node:test + tsx for tests.

## Global Constraints

- No server/API changes; computed client-side from `members` and `game.classes`.
- No inline `style=""` or inline scripts (CSP has no `'unsafe-inline'`); class colours go through `paintClasses`.
- All user-provided strings rendered through `esc()`.
- `npm run lint`, `npm run typecheck`, `npm test` must pass.

---

### Task 1: Pure `classOverview` grouping

**Files:**
- Create: `public/class-overview.js`
- Test: `test/class-overview.test.ts`

**Interfaces:**
- Produces: `classOverview(members, classes)` →
  `Array<{ cls, mainCount: number, backupCount: number, specs: Array<{ spec, mains: string[], backups: string[] }> }>`
  in `classes` order, specs in class spec order, names in `members` order.
  Members whose class/spec pair doesn't exist are ignored.

- [ ] **Step 1: Write the failing test**

`test/class-overview.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSES } from "../src/game-data.js";
import { classOverview } from "../public/class-overview.js";

const m = (characterName: string, mainClass: string, mainSpec: string, backupClass: string | null = null, backupSpec: string | null = null) => ({
  characterName, mainClass, mainSpec, backupClass, backupSpec,
});

test("lists every class and spec in order, empty when no members", () => {
  const out = classOverview([], CLASSES);
  assert.deepEqual(out.map((c) => c.cls.id), CLASSES.map((c) => c.id));
  for (const c of out) {
    assert.equal(c.mainCount, 0);
    assert.equal(c.backupCount, 0);
    assert.deepEqual(c.specs.map((s) => s.spec.id), c.cls.specs.map((s) => s.id));
    for (const s of c.specs) {
      assert.deepEqual(s.mains, []);
      assert.deepEqual(s.backups, []);
    }
  }
});

test("groups mains and backups by class and spec, keeping member order", () => {
  const members = [
    m("Mildred", "paladin", "holy"),
    m("Grumpus", "warrior", "arms", "paladin", "holy"),
    m("Gerald", "paladin", "holy"),
    m("Pops", "priest", "shadow", "warrior", "protection"),
  ];
  const out = classOverview(members, CLASSES);
  const paladin = out.find((c) => c.cls.id === "paladin")!;
  assert.equal(paladin.mainCount, 2);
  assert.equal(paladin.backupCount, 1);
  const holy = paladin.specs.find((s) => s.spec.id === "holy")!;
  assert.deepEqual(holy.mains, ["Mildred", "Gerald"]);
  assert.deepEqual(holy.backups, ["Grumpus"]);

  const warrior = out.find((c) => c.cls.id === "warrior")!;
  assert.equal(warrior.mainCount, 1);
  assert.equal(warrior.backupCount, 1);
  assert.deepEqual(warrior.specs.find((s) => s.spec.id === "protection")!.backups, ["Pops"]);
});

test("ignores unknown class/spec pairs", () => {
  const out = classOverview([m("Ghost", "deathknight", "blood"), m("Odd", "mage", "nope")], CLASSES);
  assert.equal(out.reduce((n, c) => n + c.mainCount + c.backupCount, 0), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test node --import tsx --test test/class-overview.test.ts`
Expected: FAIL — cannot find module `../public/class-overview.js`.

- [ ] **Step 3: Write minimal implementation**

`public/class-overview.js`:

```js
// Groups members by class and spec for the Classes tab. Pure, so it is unit tested from Node.
export function classOverview(members, classes) {
  return classes.map((cls) => {
    const specs = cls.specs.map((spec) => ({
      spec,
      mains: members.filter((m) => m.mainClass === cls.id && m.mainSpec === spec.id).map((m) => m.characterName),
      backups: members.filter((m) => m.backupClass === cls.id && m.backupSpec === spec.id).map((m) => m.characterName),
    }));
    return {
      cls,
      mainCount: specs.reduce((n, s) => n + s.mains.length, 0),
      backupCount: specs.reduce((n, s) => n + s.backups.length, 0),
      specs,
    };
  });
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add public/class-overview.js test/class-overview.test.ts
git commit -m "feat: class overview grouping helper"
```

---

### Task 2: Tabs and Classes panel

**Files:**
- Modify: `public/index.html` (tab bar after `.toolbar`; `id="roster-panel"` on the Roster panel; new `#class-overview` panel)
- Modify: `public/app.js` (import, `renderClassOverview`, `applyTab`, event wiring)
- Modify: `public/style.css` (tabs + class grid styles)

**Interfaces:**
- Consumes: `classOverview(members, classes)` from Task 1; existing `esc`, `ICONS`, `paintClasses`, `armory`, `openArmory(name)`, `renderRoster`.

- [ ] **Step 1: HTML**

In `public/index.html`, directly after the closing `</div>` of `.toolbar`, add:

```html
      <nav class="tabs" aria-label="Views">
        <a href="#" class="tab" data-tab="roster">Roster</a>
        <a href="#classes" class="tab" data-tab="classes">Classes</a>
      </nav>
```

Change `<section class="panel" aria-label="Roster">` to
`<section id="roster-panel" class="panel" aria-label="Roster">`, and after that
section's closing `</section>` add:

```html
      <section id="class-overview" class="panel hidden" aria-label="Classes">
        <h2>Classes</h2>
        <div id="class-grid" class="class-grid"></div>
      </section>
```

- [ ] **Step 2: JS — import and render**

At the top of `public/app.js`, before `const $ = ...`:

```js
import { classOverview } from "./class-overview.js";
```

After `renderCoverage()` add:

```js
function memberList(names) {
  return names
    .map((n) =>
      armory
        ? `<button class="member link" data-action="armory" data-name="${esc(n)}" title="View armory">${esc(n)}</button>`
        : `<span class="member">${esc(n)}</span>`,
    )
    .join(", ");
}

function renderClassOverview() {
  const grid = $("#class-grid");
  grid.innerHTML = classOverview(members, game.classes)
    .map(
      ({ cls, mainCount, backupCount, specs }) => `
    <article class="class-card">
      <h3><span class="cls" data-class="${esc(cls.id)}">${esc(cls.name)}</span><span class="muted">${mainCount} main · ${backupCount} backup</span></h3>
      <ul>${specs
        .map(
          ({ spec, mains, backups }) => `
        <li class="spec-row${mains.length || backups.length ? "" : " empty"}">
          <span class="spec-head">${ICONS[spec.role]}<span>${esc(spec.name)}</span><b>${mains.length}</b></span>
          ${mains.length ? `<span class="spec-names">${memberList(mains)}</span>` : ""}
          ${backups.length ? `<span class="spec-backups muted">+${backups.length} backup: ${memberList(backups)}</span>` : ""}
        </li>`,
        )
        .join("")}</ul>
    </article>`,
    )
    .join("");
  paintClasses(grid);
}
```

At the end of `renderRoster()`, after `renderCoverage();`, add `renderClassOverview();`.
(`initArmory` already calls `renderRoster()`, so names become armory links once it loads.)

- [ ] **Step 3: JS — tabs and events**

After `showRoster()` add:

```js
function applyTab() {
  const tab = location.hash === "#classes" ? "classes" : "roster";
  $("#roster-panel").classList.toggle("hidden", tab !== "roster");
  $("#class-overview").classList.toggle("hidden", tab !== "classes");
  for (const a of document.querySelectorAll(".tab")) {
    const on = a.dataset.tab === tab;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}
```

In the Events section, after the `#roster-body` click listener:

```js
$("#class-grid").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action='armory']");
  if (btn) openArmory(btn.dataset.name);
});
window.addEventListener("hashchange", applyTab);
```

In `boot()`, before `const r = await api("GET", "/api/game-data");`, add `applyTab();`.

- [ ] **Step 4: CSS**

In `public/style.css`, after the Coverage block (`.stat svg { ... }`):

```css
/* Tabs */
.tabs { max-width: 1100px; margin: 0 auto 16px; display: flex; gap: 4px; border-bottom: 1px solid var(--gold-dim); }
.tab {
  font-family: var(--font-head); letter-spacing: 0.04em; text-transform: uppercase; font-size: 14px;
  color: var(--muted); text-decoration: none;
  padding: 8px 16px; border: 1px solid transparent; border-bottom: 0; margin-bottom: -1px;
}
.tab:hover, .tab:focus-visible { outline: none; color: var(--gold-hi); }
.tab.active { color: var(--gold-hi); border-color: var(--gold-dim); background: var(--panel-2); }

/* Class overview */
.class-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 16px; }
.class-card { border: 1px solid var(--gold-dim); background: #0f0d09; padding: 12px; }
.class-card h3 { margin: 0 0 8px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 17px; }
.class-card h3 .muted { font-size: 12px; }
.class-card ul { list-style: none; margin: 0; padding: 0; }
.spec-row { padding: 6px 0; border-top: 1px solid rgba(107, 90, 51, 0.35); }
.spec-row.empty { opacity: 0.45; }
.spec-head { display: flex; align-items: center; gap: 8px; font-family: var(--font-head); font-size: 13px; }
.spec-head svg { width: 14px; height: 14px; fill: var(--gold); flex: 0 0 auto; }
.spec-head b { margin-left: auto; color: var(--gold-hi); font-size: 15px; }
.spec-names, .spec-backups { display: block; font-size: 15px; padding-left: 22px; }
.member { color: var(--text); font: inherit; }
.spec-backups .member { color: var(--muted); }
```

- [ ] **Step 5: Verify**

Run: `npm run lint && npm run typecheck && npm test` — all pass.

Manual (`set -a; source .env; set +a; npm run dev`, open http://localhost:3000):
- Add members across classes, including some with backups.
- Classes tab: counts and names match roster; empty specs dimmed; class names coloured.
- Reload on `#classes` stays on Classes; Roster tab returns; browser back/forward switches tabs.
- Add/edit/delete updates the grid.
- With armory enabled, a name opens the armory dialog.
- At ~375px width: one column, no horizontal scroll.
- Browser console: no CSP or JS errors.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: classes tab with class/spec overview"
```

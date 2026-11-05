import { renderCrafting } from "./crafting.js";
import { renderProgress } from "./progress.js";
import { byCoverage, classOverview } from "./class-overview.js";

const $ = (sel) => document.querySelector(sel);

const ICONS = {
  tank: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3z"/></svg>',
  healer: '<svg viewBox="0 0 24 24"><path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/></svg>',
  dps: '<svg viewBox="0 0 24 24"><path d="M3 3l6 1 9 9-2 2-9-9-1-6-3 3zm18 0 3 3-1 6-9 9-2-2 9-9 1-6-1-1zM5 17l2 2-3 3-2-2 3-3zm14 0 3 3-2 2-3-3 2-2z"/></svg>',
};
const ROLE_LABEL = { tank: "Tank", healer: "Healer", dps: "DPS" };

let game = null; // { classes, professions, sweatFactors, levelingPrefs }
let members = [];
let armory = undefined; // undefined: not loaded; null: disabled; else /api/armory/status
let sort = { key: "rank", dir: 1 }; // roster order; ties fall back to name
const classFilter = new Set(); // class ids shown in the roster table; empty = all
let crafting = null; // /api/crafting body once ready
let craftingPoll = null;
const craftingState = { query: "", profession: "", mode: "known" };
let progress = null; // /api/progress body
const progressState = { classes: new Set(), pvpSort: { key: "rank", dir: -1 } };

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
const DASH = '<span class="muted">—</span>';
// Profession names, with current skill when the armory reported it.
function profList(ids, skills = {}) {
  if (!ids.length) return DASH;
  return ids.map((p) => `${esc(profName(p))}${skills[p] ? ` <span class="muted">${skills[p].skill}</span>` : ""}`).join(", ");
}

// Blizzard exposes rank numbers only; names come from GUILD_RANKS. Rank 0 is always the Guild Master.
const rankName = (n) => armory?.ranks?.[n] ?? (n === 0 ? "Guild Master" : `Rank ${n}`);

function lastSeen(iso) {
  if (!iso) return DASH;
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  const text = days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 30 ? `${days} days ago` : new Date(iso).toLocaleDateString();
  return `<span title="${esc(new Date(iso).toLocaleString())}">${esc(text)}</span>`;
}

// Sort keys for the roster; missing values sort last whichever way.
const SORT_VALUES = {
  name: (m) => fullName(m).toLowerCase(),
  class: (m) => `${classById(m.mainClass)?.name ?? m.mainClass} ${specOf(m.mainClass, m.mainSpec)?.name ?? "~"}`.toLowerCase(),
  rank: (m) => m.guildRank,
  level: (m) => -m.level,
  ilvl: (m) => (m.armory?.itemLevel == null ? null : -m.armory.itemLevel),
  legacy: (m) => (m.armory?.legacy ? -m.armory.legacy.earned : null),
  seen: (m) => (m.armory?.lastLogin ? -Date.parse(m.armory.lastLogin) : null),
};

function sortedMembers() {
  const value = SORT_VALUES[sort.key];
  const byName = SORT_VALUES.name;
  return [...members].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x !== y) {
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    }
    return byName(a) < byName(b) ? -1 : byName(a) > byName(b) ? 1 : 0;
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function classCell(classId, specId) {
  if (!classId) return DASH;
  const c = classById(classId);
  const s = specOf(classId, specId);
  const badge = s ? `<span class="badge">${ICONS[s.role]}${ROLE_LABEL[s.role]}</span>` : "";
  const spec = s ? esc(s.name) : '<span class="muted">Spec unknown</span>';
  return `<span class="cls" data-class="${esc(c.id)}">${esc(c.name)}</span>${badge}<br><span class="spec">${spec}</span>`;
}

function sweatCell(id) {
  const i = game.sweatFactors.findIndex((c) => c.id === id);
  if (i < 0) return DASH;
  return `<span class="pill sweat-${i}">${esc(game.sweatFactors[i].name)}</span>`;
}

function levelingCell(id) {
  const c = game.levelingPrefs.find((x) => x.id === id);
  return c ? `<span class="pill">${esc(c.name)}</span>` : DASH;
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

// Colours are set via the DOM rather than inline style="" so the CSP needs no 'unsafe-inline'.
function paintClasses(root) {
  for (const el of root.querySelectorAll(".cls[data-class]")) {
    const c = classById(el.dataset.class);
    if (c) el.style.color = c.color;
  }
}

const titleCase = (slug) => slug.replace(/(^|-)(\w)/g, (_, sep, ch) => (sep ? " " : "") + ch.toUpperCase());

// ---------- Render ----------
// Role colours: the first three slots of the validated categorical palette (dark steps,
// checked against the panel surface). "Spec unknown" is a neutral, not a fourth hue.
const ROLE_COLORS = { tank: "#3987e5", healer: "#199e70", dps: "#d95926" };
const UNKNOWN_COLOR = "#5c5446";
// One hue for the ranked profession bars (validated on the panel surface).
const PROF_COLOR = "#c98500";

// SVG pie on a unit circle. Slices are separated by a stroke in the panel colour (the 2px gap).
function pieSlices(parts) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return '<circle r="0.98" class="pie-empty" />';
  let angle = -Math.PI / 2;
  return parts
    .filter((p) => p.value > 0)
    .map((p) => {
      const label = `${p.label}: ${p.value} (${Math.round((p.value / total) * 100)}%)`;
      const attrs = `class="slice" fill="${p.color}" tabindex="0" aria-label="${esc(label)}"`;
      if (p.value === total) return `<circle r="0.98" ${attrs}><title>${esc(label)}</title></circle>`;
      const start = angle;
      angle += (p.value / total) * Math.PI * 2;
      const [x1, y1, x2, y2] = [Math.cos(start), Math.sin(start), Math.cos(angle), Math.sin(angle)].map((v) => (v * 0.98).toFixed(4));
      const large = angle - start > Math.PI ? 1 : 0;
      return `<path d="M0 0 L${x1} ${y1} A0.98 0.98 0 ${large} 1 ${x2} ${y2} Z" ${attrs}><title>${esc(label)}</title></path>`;
    })
    .join("");
}

function renderCoverage() {
  const counts = { tank: 0, healer: 0, dps: 0, unknown: 0 };
  for (const m of members) counts[specOf(m.mainClass, m.mainSpec)?.role ?? "unknown"]++;
  const parts = [
    ...Object.keys(ROLE_COLORS).map((r) => ({ key: r, label: ROLE_LABEL[r], value: counts[r], color: ROLE_COLORS[r] })),
    { key: "unknown", label: "Spec unknown", value: counts.unknown, color: UNKNOWN_COLOR },
  ].filter((p) => p.key !== "unknown" || p.value > 0);
  const total = members.length;
  $("#role-pie").innerHTML = `<title id="role-pie-title">Main roles</title>${pieSlices(parts)}`;
  $("#role-legend").innerHTML = parts
    .map(
      (p) => `<li><span class="swatch" data-color="${p.color}"></span><span class="role-icon">${ICONS[p.key] ?? ""}</span><span>${esc(p.label)}</span><b>${p.value}</b><span class="muted">${total ? Math.round((p.value / total) * 100) : 0}%</span></li>`,
    )
    .join("");
  for (const sw of document.querySelectorAll("#role-legend .swatch")) sw.style.backgroundColor = sw.dataset.color;

  // Ranked bars, largest first. Counts don't sum to the roster: members have two primaries.
  const profs = primaries().map((p) => ({
    p,
    who: members.filter((m) => m.primaryProfessions.includes(p.id)).map(fullName),
  }));
  profs.sort((a, b) => b.who.length - a.who.length || a.p.name.localeCompare(b.p.name));
  const max = Math.max(1, ...profs.map((x) => x.who.length));
  const list = $("#prof-bars");
  list.innerHTML = profs
    .map(
      ({ p, who }) => `
    <li class="bar-row" tabindex="0" title="${esc(who.join(", ") || "Nobody yet")}" aria-label="${esc(p.name)}: ${who.length}">
      <span class="bar-label">${esc(p.name)}</span>
      <span class="bar-track">${who.length ? `<span class="bar-seg end" data-n="${who.length}"></span>` : ""}<span class="bar-value">${who.length}</span></span>
    </li>`,
    )
    .join("");
  for (const seg of list.querySelectorAll(".bar-seg")) {
    const f = Number(seg.dataset.n) / max;
    seg.style.width = `calc(${f * 100}% - ${f * BAR_VALUE_ROOM_EM}em)`;
    seg.style.backgroundColor = PROF_COLOR;
  }
}

const fullName = (m) => (m.surname ? `${m.characterName} ${m.surname}` : m.characterName);

// A member's full name, linked to the armory when it is enabled. Clicks are handled on #roster;
// lookups go by first name, which is all the armory route accepts.
function characterName(m, cls) {
  return armory
    ? `<button class="${cls} link" data-action="armory" data-name="${esc(m.characterName)}" title="View armory">${esc(fullName(m))}</button>`
    : `<span class="${cls}">${esc(fullName(m))}</span>`;
}

const memberList = (list) => list.map((m) => characterName(m, "member")).join(", ");

// Horizontal bars, most-played first: a class-coloured main segment plus a faint backup segment.
// Widths and colours go through the DOM, not style="", to keep the CSP free of 'unsafe-inline'.
const BAR_VALUE_ROOM_EM = 4;
const hideBarTip = () => $("#bar-tip").classList.add("hidden");

function renderClassBars(overview) {
  const rows = byCoverage(overview);
  const max = Math.max(1, ...rows.map((r) => r.mainCount + r.backupCount));
  const list = $("#class-bars");
  hideBarTip();
  list.innerHTML = rows
    .map(
      ({ cls, mainCount, backupCount }) => `
    <li class="bar-row" data-class="${esc(cls.id)}" tabindex="0" aria-label="${esc(cls.name)}: ${mainCount} main, ${backupCount} backup">
      <span class="bar-label">${esc(cls.name)}</span>
      <span class="bar-track">${mainCount ? `<span class="bar-seg${backupCount ? "" : " end"}" data-n="${mainCount}"></span>` : ""}${
        backupCount ? `<span class="bar-seg backup end" data-n="${backupCount}"></span>` : ""
      }<span class="bar-value">${mainCount}${backupCount ? `<span class="muted"> +${backupCount}</span>` : ""}</span></span>
    </li>`,
    )
    .join("");
  for (const row of list.children) {
    const color = classById(row.dataset.class).color;
    for (const seg of row.querySelectorAll(".bar-seg")) {
      // The value label rides the tip, so the longest bar leaves room for it.
      const f = Number(seg.dataset.n) / max;
      seg.style.width = `calc(${f * 100}% - ${f * BAR_VALUE_ROOM_EM}em)`;
      seg.style.backgroundColor = color;
    }
  }
}

function showBarTip(row) {
  const tip = $("#bar-tip");
  if (tip.dataset.class === row.dataset.class && !tip.classList.contains("hidden")) return;
  const o = classOverview(members, game.classes).find((c) => c.cls.id === row.dataset.class);
  tip.dataset.class = o.cls.id;
  tip.innerHTML = `<b>${esc(o.cls.name)}</b>${o.specs
    .map(
      ({ spec, mains, backups }) =>
        `<span class="tip-row"><span>${esc(spec.name)}</span><span>${mains.length}${backups.length ? `<span class="muted"> +${backups.length}</span>` : ""}</span></span>`,
    )
    .join("")}`;
  tip.classList.remove("hidden");
  const fig = row.closest("figure").getBoundingClientRect();
  const r = row.getBoundingClientRect();
  tip.style.top = `${r.bottom - fig.top + 4}px`;
}

function renderClassOverview() {
  const overview = classOverview(members, game.classes);
  renderClassBars(overview);
  const grid = $("#class-grid");
  grid.innerHTML = overview
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

// Class toggles above the roster table, each showing how many members play it.
function renderClassFilter() {
  const bar = $("#class-filter");
  const counts = Object.fromEntries(game.classes.map((c) => [c.id, members.filter((m) => m.mainClass === c.id).length]));
  bar.innerHTML =
    `<button type="button" class="chip" data-class-filter="" aria-pressed="${classFilter.size === 0}">All <b>${members.length}</b></button>` +
    game.classes
      .filter((c) => counts[c.id] > 0)
      .map(
        (c) =>
          `<button type="button" class="chip" data-class-filter="${esc(c.id)}" aria-pressed="${classFilter.has(c.id)}"><span class="cls" data-class="${esc(c.id)}">${esc(c.name)}</span> <b>${counts[c.id]}</b></button>`,
      )
      .join("");
  paintClasses(bar);
}

function renderRoster() {
  const body = $("#roster-body");
  $("#empty-msg").classList.toggle("hidden", members.length > 0);
  $("#roster-table").classList.toggle("hidden", members.length === 0);
  for (const th of document.querySelectorAll("button.sort")) {
    th.classList.toggle("active", th.dataset.sort === sort.key);
    th.dataset.dir = sort.dir > 0 ? "asc" : "desc";
  }
  const shown = sortedMembers().filter((m) => classFilter.size === 0 || classFilter.has(m.mainClass));
  renderClassFilter();
  $("#filter-empty").classList.toggle("hidden", members.length === 0 || shown.length > 0);
  body.innerHTML = shown
    .map(
      (m) => `
    <tr data-id="${m.id}">
      <td data-label="Character">${characterName(m, "name")}${
        m.armory?.title || m.armory?.race
          ? `<br><span class="muted sub">${esc([m.armory.title, m.armory.race].filter(Boolean).join(" · "))}</span>`
          : ""
      }</td>
      <td data-label="Rank">${esc(rankName(m.guildRank))}</td>
      <td data-label="Level">${m.level}</td>
      <td data-label="Main">${classCell(m.mainClass, m.mainSpec)}</td>
      <td data-label="Backup">${classCell(m.backupClass, m.backupSpec)}</td>
      <td data-label="Primaries">${profList(m.primaryProfessions, m.armory?.skills)}</td>
      <td data-label="Secondaries">${profList(m.secondaryProfessions, m.armory?.skills)}</td>
      <td data-label="iLvl">${m.armory?.itemLevel ?? DASH}</td>
      <td data-label="Legacy">${m.armory?.legacy ? `${m.armory.legacy.earned}<span class="muted">/${m.armory.legacy.total}</span>` : DASH}</td>
      <td data-label="Last Seen">${lastSeen(m.armory?.lastLogin)}</td>
      <td data-label="Sweat Factor">${sweatCell(m.sweatFactor)}</td>
      <td data-label="Leveling Pref">${levelingCell(m.levelingPref)}</td>
      <td data-label="Notes">${m.notes ? esc(m.notes) : DASH}</td>
      <td class="actions">
        <button class="btn btn-ghost btn-small" data-action="edit">Edit</button>
      </td>
    </tr>`,
    )
    .join("");
  paintClasses(body);
  renderCoverage();
  renderClassOverview();
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

const TABS = ["roster", "classes", "crafting", "progress"];

function applyTab() {
  const wanted = location.hash.slice(1);
  const hiddenTab = document.querySelector(`.tab[data-tab="${wanted}"]`)?.classList.contains("hidden");
  const tab = TABS.includes(wanted) && !hiddenTab ? wanted : "roster";
  $("#roster-panel").classList.toggle("hidden", tab !== "roster");
  $("#class-overview").classList.toggle("hidden", tab !== "classes");
  $("#crafting-panel").classList.toggle("hidden", tab !== "crafting");
  $("#progress-panel").classList.toggle("hidden", tab !== "progress");
  for (const a of document.querySelectorAll(".tab")) {
    const on = a.dataset.tab === tab;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (tab === "crafting") loadCrafting();
  if (tab === "progress") loadProgress();
}

// ---------- Crafting ----------
const itemUrl = (id) => armory.wowheadItemUrl + id;

function drawCrafting() {
  if (!crafting) return;
  renderCrafting($("#crafting-panel"), crafting, craftingState, { esc, characterName, itemUrl });
}

async function loadCrafting() {
  if (crafting) return drawCrafting();
  clearTimeout(craftingPoll);
  const r = await api("GET", "/api/crafting");
  if (crafting) return drawCrafting();
  if (r.status === 401) return showGate("Your session expired. Enter the passphrase again.");
  const status = r.ok ? r.data.status : "unavailable";
  $("#crafting-status").textContent =
    status === "building" ? "Building the recipe catalog…" : status === "unavailable" ? "The recipe catalog is unavailable right now." : "";
  if (status === "building") {
    clearTimeout(craftingPoll);
    craftingPoll = setTimeout(() => {
      if (location.hash === "#crafting") loadCrafting();
    }, 5000);
    return;
  }
  if (status !== "ready") return;
  crafting = r.data;
  $("#crafting-controls").classList.remove("hidden");
  drawCrafting();
}

// ---------- Progress ----------
function drawProgress() {
  if (!progress) return;
  renderProgress($("#progress-panel"), progress, progressState, {
    esc, characterName, paintClasses, game, today: new Date().toISOString().slice(0, 10),
  });
}

async function loadProgress() {
  if (progress) return drawProgress();
  const r = await api("GET", "/api/progress");
  if (r.status === 401) return showGate("Your session expired. Enter the passphrase again.");
  $("#progress-status").textContent = r.ok ? "" : "Progress could not be read. Try again shortly.";
  if (!r.ok) return;
  progress = r.data;
  drawProgress();
}

// ---------- Drawer ----------
// Name, class, level and professions come from the guild roster; only the rest is editable.
function openDrawer(member) {
  const cls = classById(member.mainClass);
  $("#drawer-title").textContent = fullName(member);
  if (cls) $("#drawer-title").style.color = cls.color;
  const skills = member.armory?.skills ?? {};
  const profs = [...member.primaryProfessions, ...member.secondaryProfessions]
    .map((p) => (skills[p] ? `${profName(p)} ${skills[p].skill}` : profName(p)))
    .join(", ");
  $("#drawer-synced").textContent = `${rankName(member.guildRank)} · Level ${member.level} ${member.armory?.race ?? ""} ${cls?.name ?? member.mainClass}${profs ? ` · ${profs}` : ""} — from the armory`.replace(/\s+/g, " ");
  $("#form-errors").classList.add("hidden");
  $("#form-errors").innerHTML = "";
  $("#f-id").value = member.id;
  fillSelect($("#f-main-spec"), cls ? cls.specs : [], { placeholder: "Unknown" });
  $("#f-main-spec").value = member.mainSpec ?? "";
  $("#f-backup-class").value = member.backupClass ?? "";
  fillSpecs($("#f-backup-class"), $("#f-backup-spec"), { placeholder: "—" });
  $("#f-backup-spec").value = member.backupSpec ?? "";
  $("#f-sweat").value = member.sweatFactor ?? "";
  $("#f-leveling").value = member.levelingPref ?? "";
  $("#f-notes").value = member.notes ?? "";
  const d = $("#drawer");
  d.classList.remove("hidden");
  d.setAttribute("aria-hidden", "false");
  $("#f-main-spec").focus();
}

function closeDrawer() {
  const d = $("#drawer");
  d.classList.add("hidden");
  d.setAttribute("aria-hidden", "true");
}

function formPayload() {
  return {
    mainSpec: $("#f-main-spec").value || null,
    backupClass: $("#f-backup-class").value || null,
    backupSpec: $("#f-backup-spec").value || null,
    sweatFactor: $("#f-sweat").value || null,
    levelingPref: $("#f-leveling").value || null,
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
  if (!r.ok) {
    members = [];
    $("#empty-msg").textContent = "The ledger could not be read. Try again shortly.";
    renderRoster();
    showRoster();
    return false;
  }
  members = r.data ?? [];
  $("#empty-msg").textContent = "No guild members found yet.";
  renderRoster();
  showRoster();
  crafting = null;
  progress = null;
  if (armory && location.hash === "#progress") loadProgress();
  // Needs the armory status (Wowhead URL); initArmory reloads the tab once it arrives.
  if (armory && location.hash === "#crafting") loadCrafting();
  return true;
}

// ---------- Armory ----------
async function initArmory() {
  if (armory !== undefined) return;
  const r = await api("GET", "/api/armory/status");
  armory = r.ok && r.data?.enabled ? r.data : null;
  if (!armory) return;
  // The crafting directory needs Forever's recipe catalog.
  $("#crafting-tab").classList.toggle("hidden", armory.namespace !== "forever");
  // Progress history is filled by the guild sync, which needs the armory.
  $("#progress-tab").classList.remove("hidden");
  applyTab();
  renderRoster();
}

const fetchCharacter = (name) => api("GET", `/api/armory/character/${encodeURIComponent(name)}`);

function armoryError(r, what) {
  if (r.status === 404) {
    // Forever has no realms; lookups only cover the guild's members.
    return armory.realm
      ? `${what} isn't on the armory for ${titleCase(armory.realm)}.`
      : `${what} isn't in ${titleCase(armory.guild)} on the armory.`;
  }
  if (r.status === 429) return "Slow down — too many armory lookups. Try again in a minute.";
  return "The armory is unreachable right now. Try again shortly.";
}

// Paper-doll slot layout, matching the in-game character sheet.
const DOLL_LEFT = ["HEAD", "NECK", "SHOULDER", "BACK", "CHEST", "SHIRT", "TABARD", "WRIST"];
const DOLL_RIGHT = ["HANDS", "WAIST", "LEGS", "FEET", "FINGER_1", "FINGER_2", "TRINKET_1", "TRINKET_2"];
const DOLL_WEAPONS = ["MAIN_HAND", "OFF_HAND", "RANGED"];
const SLOT_LABEL = {
  HEAD: "Head", NECK: "Neck", SHOULDER: "Shoulder", BACK: "Back", CHEST: "Chest", SHIRT: "Shirt",
  TABARD: "Tabard", WRIST: "Wrist", HANDS: "Hands", WAIST: "Waist", LEGS: "Legs", FEET: "Feet",
  FINGER_1: "Finger", FINGER_2: "Finger", TRINKET_1: "Trinket", TRINKET_2: "Trinket",
  MAIN_HAND: "Main Hand", OFF_HAND: "Off Hand", RANGED: "Ranged",
};
const POWER_STAT = { Mana: "mana", Rage: "rage", Energy: "energy" };

let armoryGear = []; // gear of the character in the open armory dialog, indexed by data-gear

function slotHtml(slot) {
  const i = armoryGear.findIndex((g) => g.slot === slot);
  if (i < 0) {
    return `<li class="slot empty" title="${esc(SLOT_LABEL[slot])}"><span class="slot-icon"></span><span class="slot-text"></span></li>`;
  }
  const g = armoryGear[i];
  const href = esc(armory.wowheadItemUrl + g.itemId);
  const icon = g.icon ? `<img src="${esc(g.icon)}" alt="" width="44" height="44" loading="lazy" />` : "";
  const enchant = g.tooltip.enchantments[0] ? `<span class="slot-enchant">${esc(g.tooltip.enchantments[0])}</span>` : "";
  return `<li class="slot q-${esc(g.quality)}" data-gear="${i}">
    <a class="slot-icon" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="${esc(g.name)}" aria-describedby="item-tip">${icon}</a>
    <span class="slot-text"><a class="slot-name" href="${href}" target="_blank" rel="noopener noreferrer" tabindex="-1">${esc(g.name)}</a>${enchant}</span>
  </li>`;
}

// Tooltip body built from Blizzard's own display strings, laid out like the in-game tooltip.
function tooltipHtml(g) {
  const t = g.tooltip;
  const line = (text, cls = "") => (text ? `<div class="${cls}">${esc(text)}</div>` : "");
  const pair = (a, b) => (a || b ? `<div class="tip-pair"><span>${esc(a ?? "")}</span><span>${esc(b ?? "")}</span></div>` : "");
  let html = `<div class="tip-name q-${esc(g.quality)}">${esc(g.name)}</div>`;
  html += line(t.binding) + line(t.unique);
  html += pair(t.slotLabel, t.typeLabel);
  html += pair(t.damage, t.speed) + line(t.dps);
  html += line(t.armor);
  html += t.stats.map((x) => line(x)).join("");
  html += t.enchantments.map((x) => line(x, "tip-green")).join("");
  html += line(t.durability) + line(t.requiredLevel);
  html += t.spells.map((x) => line(x, "tip-green")).join("");
  if (t.set) {
    html += `<div class="tip-gap"></div>${line(t.set.name, "tip-set")}`;
    html += t.set.items.map((x) => line(x.name, x.equipped ? "tip-set-item on" : "tip-set-item")).join("");
    html += `<div class="tip-gap"></div>`;
    html += t.set.effects.map((x) => line(x.text, x.active ? "tip-green" : "tip-off")).join("");
  }
  if (t.description) html += line(`"${t.description}"`, "tip-desc");
  return html;
}

function showTip(slotEl) {
  const g = armoryGear[Number(slotEl.dataset.gear)];
  const tip = $("#item-tip");
  tip.innerHTML = tooltipHtml(g);
  tip.dataset.gear = slotEl.dataset.gear;
  tip.classList.remove("hidden");
  // Beside the icon, flipping sides and clamping so it never leaves the viewport.
  const r = slotEl.querySelector(".slot-icon").getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = r.right + 12;
  if (x + w > innerWidth - 8) x = r.left - w - 12;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  const y = Math.max(8, Math.min(r.top, innerHeight - h - 8));
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTip() {
  $("#item-tip").classList.add("hidden");
  delete $("#item-tip").dataset.gear;
}

function renderStats(stats) {
  const el = $("#armory-stats");
  el.classList.toggle("hidden", !stats);
  if (!stats) return;
  const tiles = [
    ["health", "Health", stats.health],
    [POWER_STAT[stats.powerName] ?? "mana", stats.powerName, stats.power],
    ["strength", "Strength", stats.strength],
    ["intellect", "Intellect", stats.intellect],
    ["agility", "Agility", stats.agility],
    ["stamina", "Stamina", stats.stamina],
    ["crit", "Critical Strike", `${stats.crit}%`],
    ["spirit", "Spirit", stats.spirit],
  ];
  el.innerHTML = tiles
    .map(([key, label, value]) => `<div class="stat-tile stat-${key}"><span class="stat-ring"></span><span><b>${esc(typeof value === "number" ? value.toLocaleString() : value)}</b>${esc(label)}</span></div>`)
    .join("");
}

async function openArmory(name) {
  hideTip();
  armoryGear = [];
  $("#armory-name").textContent = name;
  $("#armory-name").style.color = "";
  for (const id of ["#armory-ilvl", "#armory-sub", "#armory-spec"]) $(id).textContent = "";
  $("#armory-crest").className = "crest hidden";
  $("#armory-doll").classList.add("hidden");
  $("#armory-stats").classList.add("hidden");
  $("#armory-extra").classList.add("hidden");
  $("#armory-status").textContent = "Consulting the armory…";
  $("#armory").showModal();

  const r = await fetchCharacter(name);
  if (r.status === 401) {
    $("#armory").close();
    return showGate("Your session expired. Enter the passphrase again.");
  }
  if (!r.ok) {
    $("#armory-status").textContent = armoryError(r, name);
    return;
  }
  const c = r.data;
  const cls = classById(c.classId);
  $("#armory-status").textContent = "";
  $("#armory-name").textContent = c.surname ? `${c.name} ${c.surname}` : c.name;
  if (cls) $("#armory-name").style.color = cls.color;
  if (c.faction) $("#armory-crest").className = `crest crest-${c.faction}`;
  $("#armory-ilvl").textContent = c.itemLevel ? `${c.itemLevel} ILVL` : "";
  $("#armory-sub").textContent = [
    c.title && `${c.title} ·`,
    `${c.level} ${c.race ?? ""} ${cls?.name ?? ""}`.replace(/\s+/g, " ").trim(),
    c.guild && `<${c.guild}>`,
    armory.realm && titleCase(armory.realm),
    c.lastLogin && `· last seen ${new Date(c.lastLogin).toLocaleDateString()}`,
  ]
    .filter(Boolean)
    .join(" ");
  if (c.spec) {
    const spec = specOf(c.classId, c.spec.specId);
    const pts = Object.values(c.spec.points).sort((a, b) => b - a).join(" / ");
    $("#armory-spec").textContent = `Talents suggest ${spec?.name ?? c.spec.specId} (${pts})`;
  }

  armoryGear = c.gear;
  $("#doll-left").innerHTML = DOLL_LEFT.map(slotHtml).join("");
  $("#doll-right").innerHTML = DOLL_RIGHT.map(slotHtml).join("");
  $("#doll-weapons").innerHTML = DOLL_WEAPONS.map(slotHtml).join("");
  const render = $("#armory-render");
  render.classList.toggle("hidden", !(c.renderUrl || c.avatarUrl));
  render.classList.toggle("is-avatar", !c.renderUrl);
  if (c.renderUrl || c.avatarUrl) render.src = c.renderUrl ?? c.avatarUrl;
  $("#armory-doll").classList.remove("hidden");
  renderStats(c.stats);
  renderExtra(c);
}

// Progress, professions and reputations below the paper doll.
function renderExtra(c) {
  const facts = [
    c.legacy && ["Legacy", `${c.legacy.earned} / ${c.legacy.total}`],
    c.achievementPoints != null && ["Achievement Points", c.achievementPoints.toLocaleString()],
    c.pvp && ["PvP Rank", c.pvp.rank ? `Rank ${c.pvp.rank}` : "None"],
    c.pvp && ["Honorable Kills", c.pvp.honorableKills.toLocaleString()],
    c.gender && ["Gender", c.gender],
  ].filter(Boolean);
  const skills = c.professions?.skills ?? {};
  const profs = [...(c.professions?.primary ?? []), ...(c.professions?.secondary ?? [])];
  const bar = (label, value, max, note) => `
    <li class="meter"><span class="meter-label">${esc(label)}</span><span class="meter-track"><span class="meter-fill" data-pct="${max ? Math.min(100, (value / max) * 100) : 0}"></span></span><span class="meter-note">${esc(note)}</span></li>`;
  const sections = [
    facts.length && `<section><h3>Progress</h3><dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></section>`,
    profs.length &&
      `<section><h3>Professions</h3><ul class="meters">${profs
        .map((p) => (skills[p] ? bar(profName(p), skills[p].skill, skills[p].max, `${skills[p].skill} / ${skills[p].max}`) : bar(profName(p), 0, 0, "—")))
        .join("")}</ul></section>`,
    c.reputations?.length &&
      `<section><h3>Reputation</h3><ul class="meters">${c.reputations
        .map((r) => bar(r.faction, r.value, r.max, `${r.standing} ${r.value} / ${r.max}`))
        .join("")}</ul></section>`,
  ].filter(Boolean);
  const el = $("#armory-extra");
  el.innerHTML = sections.join("");
  el.classList.toggle("hidden", sections.length === 0);
  // Widths through the DOM, not style="", to keep the CSP free of 'unsafe-inline'.
  for (const fill of el.querySelectorAll(".meter-fill")) fill.style.width = `${fill.dataset.pct}%`;
}

function initForm() {
  fillSelect($("#f-backup-class"), game.classes, { placeholder: "None" });
  fillSelect($("#f-sweat"), game.sweatFactors, { placeholder: "—" });
  fillSelect($("#f-leveling"), game.levelingPrefs, { placeholder: "—" });
  $("#f-backup-class").addEventListener("change", () => fillSpecs($("#f-backup-class"), $("#f-backup-spec"), { placeholder: "—" }));
}

// ---------- Events ----------
$("#gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await api("POST", "/api/login", { passphrase: $("#gate-pass").value });
  if (!r.ok) {
    const msg =
      r.status === 401
        ? "The guild does not recognize that passphrase."
        : r.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "Something went wrong. Try again shortly.";
    showGate(msg);
    return;
  }
  $("#gate-pass").value = "";
  if (await loadMembers()) await initArmory();
});

$("#logout-btn").addEventListener("click", async () => {
  await api("POST", "/api/logout");
  members = [];
  showGate();
});

$("#cancel-btn").addEventListener("click", closeDrawer);
$("#drawer").addEventListener("click", (e) => {
  if (e.target === $("#drawer")) closeDrawer();
});

$("#member-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await api("PUT", `/api/members/${$("#f-id").value}`, formPayload());
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
});

$("#class-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-class-filter]");
  if (!btn) return;
  const id = btn.dataset.classFilter;
  if (!id) classFilter.clear();
  else if (classFilter.has(id)) classFilter.delete(id);
  else classFilter.add(id);
  renderRoster();
});

$("#crafting-search").addEventListener("input", (e) => {
  craftingState.query = e.target.value;
  drawCrafting();
});
$("#crafting-profs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-profession]");
  if (!btn) return;
  craftingState.profession = btn.dataset.profession;
  drawCrafting();
});
$("#crafting-mode").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  craftingState.mode = btn.dataset.mode;
  drawCrafting();
});

$("#progress-class-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-progress-class]");
  if (!btn) return;
  const id = btn.dataset.progressClass;
  if (!id) progressState.classes.clear();
  else if (progressState.classes.has(id)) progressState.classes.delete(id);
  else progressState.classes.add(id);
  drawProgress();
});
$("#pvp-section thead").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-pvp-sort]");
  if (!btn) return;
  const key = btn.dataset.pvpSort;
  progressState.pvpSort = key === progressState.pvpSort.key
    ? { key, dir: -progressState.pvpSort.dir }
    : { key, dir: key === "name" ? 1 : -1 };
  drawProgress();
});

$("#roster-table thead").addEventListener("click", (e) => {
  const btn = e.target.closest("button.sort");
  if (!btn) return;
  sort = btn.dataset.sort === sort.key ? { key: sort.key, dir: -sort.dir } : { key: btn.dataset.sort, dir: 1 };
  renderRoster();
});

$("#roster").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action='armory']");
  if (btn) openArmory(btn.dataset.name);
});
window.addEventListener("hashchange", applyTab);
const bars = $("#class-bars");
bars.addEventListener("mouseover", (e) => {
  const row = e.target.closest(".bar-row");
  if (row) showBarTip(row);
});
bars.addEventListener("mouseleave", hideBarTip);
bars.addEventListener("focusin", (e) => showBarTip(e.target.closest(".bar-row")));
bars.addEventListener("focusout", hideBarTip);

$("#armory-close").addEventListener("click", () => $("#armory").close());
$("#armory").addEventListener("close", hideTip);
const doll = $("#armory-doll");
// Taps also fire emulated mouseover/focus before click; track the real pointer so touch
// goes through the tap-to-preview path below instead.
let lastPointer = "mouse";
doll.addEventListener("pointerdown", (e) => (lastPointer = e.pointerType));
document.addEventListener("keydown", () => (lastPointer = "keyboard"));
doll.addEventListener("mouseover", (e) => {
  if (lastPointer === "touch") return;
  const slot = e.target.closest(".slot[data-gear]");
  if (slot && $("#item-tip").dataset.gear !== slot.dataset.gear) showTip(slot);
});
doll.addEventListener("mouseleave", hideTip);
doll.addEventListener("mouseout", (e) => {
  if (!e.relatedTarget?.closest?.(".slot[data-gear]")) hideTip();
});
doll.addEventListener("focusin", (e) => {
  if (lastPointer === "touch") return;
  const slot = e.target.closest(".slot[data-gear]");
  if (slot) showTip(slot);
});
doll.addEventListener("focusout", hideTip);
// Touch has no hover: the first tap on a slot shows its tooltip, a second tap opens Wowhead.
doll.addEventListener("click", (e) => {
  const slot = e.target.closest(".slot[data-gear]");
  if (!slot || lastPointer !== "touch") return;
  if ($("#item-tip").dataset.gear !== slot.dataset.gear) {
    e.preventDefault();
    showTip(slot);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#drawer").classList.contains("hidden")) closeDrawer();
});

// ---------- Boot ----------
(async function boot() {
  applyTab();
  const r = await api("GET", "/api/game-data");
  if (!r.ok || !r.data) {
    showGate("The guild hall is unreachable right now.");
    return;
  }
  game = r.data;
  initForm();
  if (await loadMembers()) await initArmory();
})();

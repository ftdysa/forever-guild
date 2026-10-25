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
let pendingDeleteId = null;
let armory = undefined; // undefined: not loaded; null: disabled; else /api/armory/status
let guildRoster = null; // cached /api/armory/roster for the import dialog

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
const DASH = '<span class="muted">—</span>';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function classCell(classId, specId) {
  if (!classId) return DASH;
  const c = classById(classId);
  const s = specOf(classId, specId);
  const badge = s ? `<span class="badge">${ICONS[s.role]}${ROLE_LABEL[s.role]}</span>` : "";
  return `<span class="cls" data-class="${esc(c.id)}">${esc(c.name)}</span>${badge}<br><span class="spec">${esc(s?.name ?? specId)}</span>`;
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

// A character name, linked to the armory when it is enabled. Clicks are handled on #roster.
function characterName(name, cls) {
  return armory
    ? `<button class="${cls} link" data-action="armory" data-name="${esc(name)}" title="View armory">${esc(name)}</button>`
    : `<span class="${cls}">${esc(name)}</span>`;
}

const memberList = (names) => names.map((n) => characterName(n, "member")).join(", ");

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

function renderRoster() {
  const body = $("#roster-body");
  $("#empty-msg").classList.toggle("hidden", members.length > 0);
  $("#roster-table").classList.toggle("hidden", members.length === 0);
  body.innerHTML = members
    .map(
      (m) => `
    <tr data-id="${m.id}">
      <td data-label="Character">${characterName(m.characterName, "name")}</td>
      <td data-label="Main">${classCell(m.mainClass, m.mainSpec)}</td>
      <td data-label="Backup">${classCell(m.backupClass, m.backupSpec)}</td>
      <td data-label="Primaries">${m.primaryProfessions.map((p) => esc(profName(p))).join(", ")}</td>
      <td data-label="Secondaries">${m.secondaryProfessions.length ? m.secondaryProfessions.map((p) => esc(profName(p))).join(", ") : DASH}</td>
      <td data-label="Sweat Factor">${sweatCell(m.sweatFactor)}</td>
      <td data-label="Leveling Pref">${levelingCell(m.levelingPref)}</td>
      <td data-label="Notes">${m.notes ? esc(m.notes) : DASH}</td>
      <td class="actions">
        <button class="btn btn-ghost btn-small" data-action="edit">Edit</button>
        <button class="btn btn-danger btn-small" data-action="delete">Remove</button>
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

// ---------- Drawer ----------
// `member` is the record being edited (null when adding); `draft` supplies field values,
// e.g. a partial member pre-filled from the armory.
function openDrawer(member, draft = member, note = "") {
  $("#drawer-title").textContent = member ? "Edit Member" : "Add Member";
  $("#drawer-note").textContent = note;
  $("#drawer-note").classList.toggle("hidden", !note);
  $("#form-errors").classList.add("hidden");
  $("#form-errors").innerHTML = "";
  $("#f-id").value = member?.id ?? "";
  $("#f-name").value = draft?.characterName ?? "";
  $("#f-main-class").value = classById(draft?.mainClass) ? draft.mainClass : game.classes[0].id;
  fillSpecs($("#f-main-class"), $("#f-main-spec"));
  $("#f-main-spec").value = draft?.mainSpec ?? "";
  if (!$("#f-main-spec").value) $("#f-main-spec").selectedIndex = 0;
  $("#f-backup-class").value = draft?.backupClass ?? "";
  fillSpecs($("#f-backup-class"), $("#f-backup-spec"), { placeholder: "—" });
  $("#f-backup-spec").value = draft?.backupSpec ?? "";
  const prim1 = draft?.primaryProfessions?.[0] ?? primaries()[0].id;
  $("#f-prim-1").value = prim1;
  $("#f-prim-2").value = draft?.primaryProfessions?.[1] ?? primaries().find((p) => p.id !== prim1).id;
  for (const cb of document.querySelectorAll("#f-secondaries input")) {
    cb.checked = draft?.secondaryProfessions?.includes(cb.value) ?? false;
  }
  $("#f-sweat").value = draft?.sweatFactor ?? "";
  $("#f-leveling").value = draft?.levelingPref ?? "";
  $("#f-notes").value = draft?.notes ?? "";
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
  guildRoster = null; // membership changed or reloaded: refetch so "On roster" flags stay current
  $("#empty-msg").textContent = "No members yet. Be the first to sign the ledger.";
  renderRoster();
  showRoster();
  return true;
}

// ---------- Armory ----------
async function initArmory() {
  if (armory !== undefined) return;
  const r = await api("GET", "/api/armory/status");
  armory = r.ok && r.data?.enabled ? r.data : null;
  if (!armory) return;
  $("#import-btn").classList.remove("hidden");
  $("#import-title").textContent = `Import from ${titleCase(armory.guild)} — ${titleCase(armory.realm)}`;
  renderRoster();
}

const fetchCharacter = (name) => api("GET", `/api/armory/character/${encodeURIComponent(name)}`);

function armoryError(r, what) {
  if (r.status === 404) return `${what} isn't on the armory for ${titleCase(armory.realm)}.`;
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
  $("#armory-name").textContent = c.name;
  if (cls) $("#armory-name").style.color = cls.color;
  if (c.faction) $("#armory-crest").className = `crest crest-${c.faction}`;
  $("#armory-ilvl").textContent = c.itemLevel ? `${c.itemLevel} ILVL` : "";
  $("#armory-sub").textContent = [
    `${c.level} ${c.race ?? ""} ${cls?.name ?? ""}`.replace(/\s+/g, " ").trim(),
    c.guild && `<${c.guild}>`,
    titleCase(armory.realm),
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
}

async function openImport() {
  $("#import").showModal();
  if (!guildRoster) {
    $("#import-status").textContent = "Fetching the guild roster…";
    $("#import-body").innerHTML = "";
    const r = await api("GET", "/api/armory/roster");
    if (r.status === 401) {
      $("#import").close();
      return showGate("Your session expired. Enter the passphrase again.");
    }
    if (!r.ok) {
      $("#import-status").textContent = armoryError(r, "The guild");
      return;
    }
    guildRoster = r.data;
  }
  renderImport();
  $("#import-search").focus();
}

function renderImport() {
  if (!guildRoster) return;
  const q = $("#import-search").value.trim().toLowerCase();
  const min = Number($("#import-min").value) || 1;
  const rows = guildRoster.filter((m) => m.level >= min && m.name.toLowerCase().includes(q));
  $("#import-status").textContent = `Showing ${rows.length} of ${guildRoster.length} guild members.`;
  const body = $("#import-body");
  body.innerHTML = rows
    .map(
      (m) => `<tr>
        <td data-label="Character"><span class="name">${esc(m.name)}</span></td>
        <td data-label="Level">${m.level}</td>
        <td data-label="Class">${m.classId ? `<span class="cls" data-class="${esc(m.classId)}">${esc(classById(m.classId)?.name ?? m.classId)}</span>` : DASH}</td>
        <td class="actions">${
          m.onRoster
            ? '<span class="muted">On roster</span>'
            : `<button class="btn btn-small" data-import="${esc(m.name)}">Add</button>`
        }</td>
      </tr>`,
    )
    .join("");
  paintClasses(body);
}

async function importMember(btn) {
  const entry = guildRoster.find((m) => m.name === btn.dataset.import);
  if (!entry) return;
  btn.disabled = true;
  btn.textContent = "…";
  const r = await fetchCharacter(entry.name);
  if (r.status === 401) {
    $("#import").close();
    return showGate("Your session expired. Enter the passphrase again.");
  }
  const c = r.ok ? r.data : null;
  const notes = [];
  if (!c) notes.push(`Couldn't read ${entry.name}'s armory, so only name and class are filled in.`);
  else if (c.spec) {
    const pts = Object.entries(c.spec.points).map(([id, n]) => `${specOf(c.classId, id)?.name ?? id} ${n}`).join(" · ");
    notes.push(`Spec guessed from talents (${pts}).`);
  } else notes.push("Couldn't guess a spec from talents — pick one below.");
  if (c && !c.professions) notes.push("Professions aren't available from this realm's armory — pick them below.");
  $("#import").close();
  openDrawer(
    null,
    {
      characterName: entry.name,
      mainClass: c?.classId ?? entry.classId,
      mainSpec: c?.spec?.specId,
      primaryProfessions: c?.professions?.primary,
      secondaryProfessions: c?.professions?.secondary,
    },
    `Pre-filled from the armory. ${notes.join(" ")}`,
  );
}

function initForm() {
  fillSelect($("#f-main-class"), game.classes);
  fillSelect($("#f-backup-class"), game.classes, { placeholder: "None" });
  fillSelect($("#f-prim-1"), primaries());
  fillSelect($("#f-prim-2"), primaries());
  fillSelect($("#f-sweat"), game.sweatFactors, { placeholder: "—" });
  fillSelect($("#f-leveling"), game.levelingPrefs, { placeholder: "—" });
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

$("#import-btn").addEventListener("click", openImport);
$("#import-close").addEventListener("click", () => $("#import").close());
$("#import-search").addEventListener("input", renderImport);
$("#import-min").addEventListener("input", renderImport);
$("#import-body").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-import]");
  if (btn) importMember(btn);
});
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

$("#confirm-cancel").addEventListener("click", () => $("#confirm").close());
$("#confirm-ok").addEventListener("click", async () => {
  const id = pendingDeleteId;
  pendingDeleteId = null;
  $("#confirm").close();
  const r = await api("DELETE", `/api/members/${id}`);
  if (r.status === 401) return showGate("Your session expired. Enter the passphrase again.");
  // 404 means already removed; reload reflects reality
  await loadMembers();
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

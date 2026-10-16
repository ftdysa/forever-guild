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

function renderRoster() {
  const body = $("#roster-body");
  $("#empty-msg").classList.toggle("hidden", members.length > 0);
  $("#roster-table").classList.toggle("hidden", members.length === 0);
  body.innerHTML = members
    .map(
      (m) => `
    <tr data-id="${m.id}">
      <td data-label="Character">${
        armory
          ? `<button class="name link" data-action="armory" title="View armory">${esc(m.characterName)}</button>`
          : `<span class="name">${esc(m.characterName)}</span>`
      }</td>
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

async function openArmory(name) {
  $("#armory-name").textContent = name;
  $("#armory-name").className = "";
  for (const id of ["#armory-sub", "#armory-spec"]) $(id).textContent = "";
  $("#armory-gear").innerHTML = "";
  $("#armory-avatar").classList.add("hidden");
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
  if (cls) {
    $("#armory-name").className = "cls";
    $("#armory-name").style.color = cls.color;
  }
  $("#armory-sub").textContent = [
    `Level ${c.level} ${c.race ?? ""} ${cls?.name ?? ""}`.replace(/\s+/g, " ").trim(),
    c.guild && `<${c.guild}>`,
    c.itemLevel && `iLvl ${c.itemLevel}`,
    c.lastLogin && `Last seen ${new Date(c.lastLogin).toLocaleDateString()}`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (c.spec) {
    const spec = specOf(c.classId, c.spec.specId);
    const pts = Object.values(c.spec.points).sort((a, b) => b - a).join(" / ");
    $("#armory-spec").textContent = `Talents suggest ${spec?.name ?? c.spec.specId} (${pts})`;
  }
  if (c.avatarUrl) {
    $("#armory-avatar").src = c.avatarUrl;
    $("#armory-avatar").classList.remove("hidden");
  }
  $("#armory-gear").innerHTML = c.gear.length
    ? c.gear
        .map(
          (g) => `<li><span class="slot">${esc(g.slot)}</span>
            <a class="q-${esc(g.quality)}" href="${esc(armory.wowheadItemUrl + g.itemId)}" target="_blank" rel="noopener noreferrer">${esc(g.name)}</a></li>`,
        )
        .join("")
    : '<li class="muted">No gear equipped.</li>';
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
  if (btn.dataset.action === "armory") openArmory(m.characterName);
  if (btn.dataset.action === "delete") {
    pendingDeleteId = id;
    $("#confirm-text").textContent = `${m.characterName} will be struck from the ledger.`;
    $("#confirm").showModal();
  }
});

$("#import-btn").addEventListener("click", openImport);
$("#import-close").addEventListener("click", () => $("#import").close());
$("#import-search").addEventListener("input", renderImport);
$("#import-min").addEventListener("input", renderImport);
$("#import-body").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-import]");
  if (btn) importMember(btn);
});
$("#armory-close").addEventListener("click", () => $("#armory").close());

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
  const r = await api("GET", "/api/game-data");
  if (!r.ok || !r.data) {
    showGate("The guild hall is unreachable right now.");
    return;
  }
  game = r.data;
  initForm();
  if (await loadMembers()) await initArmory();
})();

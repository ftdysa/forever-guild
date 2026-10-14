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

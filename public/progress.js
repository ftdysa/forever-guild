// Progress tab: models are pure (unit tested from Node); rendering takes app helpers.
export const TOP = 10;
const DAY_MS = 86_400_000;

export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const lastLevel = (s) => s.levels[s.levels.length - 1][1];
// The day the character first showed their current level.
const reachedOn = (s) => s.levels.find((p) => p[1] === lastLevel(s))[0];

// Lines ranked for the level race; the top TOP are leaders. classes: Set of class ids (empty = all).
export function levelRace(series, { classes, today }) {
  const shown = series.filter((s) => classes.size === 0 || classes.has(s.class));
  const ranked = [...shown].sort(
    (a, b) => lastLevel(b) - lastLevel(a) || reachedOn(a).localeCompare(reachedOn(b)) || a.name.localeCompare(b.name),
  );
  const start = shown.flatMap((s) => s.levels.map((p) => p[0])).reduce((a, b) => (a < b ? a : b), today);
  return { start, end: today, lines: ranked.map((s, i) => ({ ...s, leader: i < TOP })) };
}

const round = (n) => Math.round(n * 10) / 10;

// SVG path for [day, value] points in a width × height box, held flat out to geo.end.
export function linePath(points, { start, end, width, height, min, max }) {
  const span = Math.max(1, daysBetween(start, end));
  const x = (d) => round((daysBetween(start, d) / span) * width);
  const y = (v) => round(height - ((v - min) / (max - min)) * height);
  const pts = points.map(([d, v]) => [x(d), y(v)]);
  const last = points[points.length - 1];
  if (last && last[0] < end) pts.push([x(end), y(last[1])]);
  return "M" + pts.map(([a, b]) => `${a},${b}`).join("L");
}

// Nudges label y positions down so none are closer than `gap`; returns them in input order.
export function spreadLabels(ys, gap = 12) {
  const out = [];
  let prev = -Infinity;
  for (const [y, i] of ys.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0])) {
    out[i] = Math.max(y, prev + gap);
    prev = out[i];
  }
  return out;
}

const HORDE = new Set(["Orc", "Troll", "Tauren", "Undead"]);
const ALLIANCE = new Set(["Human", "Dwarf", "Night Elf", "Gnome"]);
const TITLES = {
  horde: ["Scout", "Grunt", "Sergeant", "Senior Sergeant", "First Sergeant", "Stone Guard", "Blood Guard", "Legionnaire", "Centurion", "Champion", "Lieutenant General", "General", "Warlord", "High Warlord"],
  alliance: ["Private", "Corporal", "Sergeant", "Master Sergeant", "Sergeant Major", "Knight", "Knight-Lieutenant", "Knight-Captain", "Knight-Champion", "Lieutenant Commander", "Commander", "Marshal", "Field Marshal", "Grand Marshal"],
};

export function rankTitle(rank, race) {
  if (!rank) return "None";
  const titles = HORDE.has(race) ? TITLES.horde : ALLIANCE.has(race) ? TITLES.alliance : null;
  return titles?.[rank - 1] ?? `Rank ${rank}`;
}

// Cards for the guild firsts board, grouped and ordered for display.
export function firstsGroups(firsts, game) {
  const card = (id, title, c, extra = {}) => ({ id, title, holders: c.holders, atLaunch: c.atLaunch, ...extra });
  return [
    { heading: "Level 60", cards: [card("overall", "First to 60", firsts.overall60)] },
    { heading: "Classes", cards: game.classes.map((c) => card(`class-${c.id}`, c.name, firsts.byClass[c.id], { classId: c.id })) },
    { heading: "Races", cards: Object.keys(firsts.byRace).sort().map((r) => card(`race-${r}`, r, firsts.byRace[r])) },
    { heading: "Professions", cards: game.professions.map((p) => card(`skill-${p.id}`, `${p.name} 300`, firsts.bySkill[p.id])) },
    {
      heading: "PvP ranks",
      cards: Object.keys(firsts.byPvpRank)
        .map(Number)
        .sort((a, b) => a - b)
        .map((n) => card(`rank-${n}`, `Rank ${n}`, firsts.byPvpRank[String(n)], { rank: n })),
    },
  ];
}

const PVP_SORT = {
  name: (r) => r.name.toLowerCase(),
  rank: (r) => r.rank,
  highest: (r) => r.highestRank,
  hk: (r) => r.honorableKills,
};

export function pvpRows(pvp, { key, dir }) {
  const value = PVP_SORT[key];
  return [...pvp].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return x === y ? a.name.localeCompare(b.name) : (x < y ? -1 : 1) * dir;
  });
}

// ---------- Rendering ----------
const W = 800;
const H = 340;
const PAD = { l: 34, r: 130, t: 12, b: 26 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;
const fmtDate = (iso) => new Date(iso).toLocaleDateString();

function raceChart(model, { esc, colorOf }) {
  const geo = { start: model.start, end: model.end, width: IW, height: IH, min: 1, max: 60 };
  const y = (v) => round(IH - ((v - 1) / 59) * IH);
  const grid = [10, 20, 30, 40, 50, 60]
    .map((v) => `<line class="race-grid" x1="0" x2="${IW}" y1="${y(v)}" y2="${y(v)}"/><text class="race-axis" x="-6" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${v}</text>`)
    .join("");
  const axis = `<text class="race-axis" x="0" y="${IH + 18}">${esc(model.start)}</text><text class="race-axis" x="${IW}" y="${IH + 18}" text-anchor="end">${esc(model.end)}</text>`;
  const path = (l) => {
    const level = lastLevel(l);
    const cls = `race-line${l.leader ? " leader" : ""}${l.current ? "" : " former"}`;
    const stroke = l.leader ? ` stroke="${esc(colorOf(l.class))}"` : "";
    const focus = l.leader ? ' tabindex="0"' : "";
    return `<path class="${cls}" d="${linePath(l.levels, geo)}"${stroke}${focus}><title>${esc(l.name)} — level ${level}${l.current ? "" : " (former member)"}</title></path>`;
  };
  // Leaders on top, first place last so it is drawn over the others.
  const pack = model.lines.filter((l) => !l.leader).map(path).join("");
  const leaders = model.lines.filter((l) => l.leader);
  const lines = [...leaders].reverse().map(path).join("");
  const labelYs = spreadLabels(leaders.map((l) => y(lastLevel(l))));
  const labels = leaders
    .map((l, i) => `<text class="race-label" x="${IW + 6}" y="${labelYs[i]}" dominant-baseline="middle" fill="${esc(colorOf(l.class))}">${esc(l.name)} ${lastLevel(l)}</text>`)
    .join("");
  return `<svg class="race-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Level over time"><g transform="translate(${PAD.l},${PAD.t})">${grid}${axis}${pack}${lines}${labels}</g></svg>`;
}

function spark(history, { esc, today }) {
  const points = history.map(([d, rank]) => [d, rank]);
  const geo = { start: points[0][0], end: today, width: 80, height: 18, min: 0, max: 14 };
  return `<svg class="spark" viewBox="-1 -1 82 20" role="img" aria-label="${esc(`Rank history, now ${points[points.length - 1][1]}`)}"><path d="${linePath(points, geo)}"/></svg>`;
}

// Renders the Progress tab into `root` (#progress-panel).
export function renderProgress(root, data, state, { esc, characterName, paintClasses, game, today }) {
  const colorOf = (id) => game.classes.find((c) => c.id === id)?.color ?? "#C0C0C0";
  const who = (name, current) =>
    current ? characterName({ characterName: name, surname: null }, "member") : `<span class="member former">${esc(name)}</span> <span class="muted">(former)</span>`;

  // Class filter
  const counts = {};
  for (const s of data.series) counts[s.class] = (counts[s.class] ?? 0) + 1;
  root.querySelector("#progress-class-filter").innerHTML =
    `<button type="button" class="chip" data-progress-class="" aria-pressed="${state.classes.size === 0}">All <b>${data.series.length}</b></button>` +
    game.classes
      .filter((c) => counts[c.id])
      .map((c) => `<button type="button" class="chip" data-progress-class="${esc(c.id)}" aria-pressed="${state.classes.has(c.id)}"><span class="cls" data-class="${esc(c.id)}">${esc(c.name)}</span> <b>${counts[c.id]}</b></button>`)
      .join("");

  // Level race
  const model = levelRace(data.series, { classes: state.classes, today });
  const chart = root.querySelector("#race-chart");
  const note = root.querySelector("#race-note");
  if (!data.trackingSince) {
    chart.innerHTML = "";
    note.textContent = "No history yet. It fills in as the guild sync runs.";
  } else if (data.trackingSince === today) {
    chart.innerHTML = "";
    note.textContent = `Tracking started ${data.trackingSince}; the race fills in as people level.`;
  } else {
    chart.innerHTML = model.lines.length ? raceChart(model, { esc, colorOf }) : '<p class="muted">No members play the selected classes.</p>';
    note.textContent = `Since ${data.trackingSince}. Top ${TOP} highlighted; hover any line for its name.`;
  }

  // Guild firsts
  const holderLi = (h, rank) =>
    `<li>${who(h.name, h.current)}${rank ? ` <span class="muted">${esc(rankTitle(rank, data.series.find((s) => s.name === h.name)?.race ?? null))}</span>` : ""} <span class="muted">· ${esc(fmtDate(h.reachedAt))}${h.source === "achievement" ? " · via achievement" : ""}</span></li>`;
  const cardHtml = (c) => `<article class="first-card">
      <h4>${c.classId ? `<span class="cls" data-class="${esc(c.classId)}">${esc(c.title)}</span>` : esc(c.title)}</h4>
      ${c.holders.length ? `<ol class="first-holders">${c.holders.map((h) => holderLi(h, c.rank)).join("")}</ol>` : c.atLaunch.length ? "" : '<p class="muted">Unclaimed</p>'}
      ${c.atLaunch.length ? `<p class="muted small">Already there at launch: ${c.atLaunch.map((n) => esc(n)).join(", ")}</p>` : ""}
    </article>`;
  root.querySelector("#firsts").innerHTML = firstsGroups(data.firsts, game)
    .filter((g) => g.cards.length)
    .map((g) => `<section class="firsts-group"><h3>${esc(g.heading)}</h3><div class="firsts-grid">${g.cards.map(cardHtml).join("")}</div></section>`)
    .join("");

  // PvP tracker
  root.querySelector("#pvp-section").classList.toggle("hidden", data.pvp.length === 0);
  for (const b of root.querySelectorAll("button[data-pvp-sort]")) {
    const on = b.dataset.pvpSort === state.pvpSort.key;
    b.closest("th").setAttribute("aria-sort", on ? (state.pvpSort.dir === 1 ? "ascending" : "descending") : "none");
  }
  root.querySelector("#pvp-body").innerHTML = pvpRows(data.pvp, state.pvpSort)
    .map(
      (r) => `<tr>
        <td><span class="cls" data-class="${esc(r.class)}">${who(r.name, r.current)}</span></td>
        <td>${r.rank} <span class="muted">${esc(rankTitle(r.rank, r.race))}</span></td>
        <td>${r.highestRank} <span class="muted">${esc(rankTitle(r.highestRank, r.race))}</span></td>
        <td>${r.honorableKills.toLocaleString()}</td>
        <td>${spark(r.history, { esc, today })}</td>
      </tr>`,
    )
    .join("");
  paintClasses(root);
}

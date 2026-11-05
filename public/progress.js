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

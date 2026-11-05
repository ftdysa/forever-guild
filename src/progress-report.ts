import { computeFirsts, type Firsts } from "./milestones.js";
import { progressName } from "./progress.js";
import type { Milestone, Snapshot } from "./progress-store.js";

export interface LevelSeries {
  name: string;
  class: string;
  race: string | null;
  current: boolean;
  levels: [string, number][];
}

export interface PvpSeries {
  name: string;
  class: string;
  race: string | null;
  current: boolean;
  rank: number;
  highestRank: number;
  honorableKills: number;
  history: [string, number, number][];
}

export interface Standing {
  name: string;
  class: string;
  race: string | null;
  level: number;
  // First day this character was seen at its current level.
  reachedOn: string;
  gained7d: number;
}

export interface FirstsCount {
  name: string;
  class: string;
  count: number;
}

export interface SkillEntry {
  name: string;
  class: string;
  skill: number;
}

export interface Leaderboard {
  standings: Standing[];
  fastest: Standing[];
  mostFirsts: FirstsCount[];
  skills: Record<string, SkillEntry[]>;
}

export interface ProgressReport {
  trackingSince: string | null;
  series: LevelSeries[];
  pvp: PvpSeries[];
  firsts: Firsts;
  leaderboard: Leaderboard;
  // Current members by lowercased progress name, so any name shown can open their armory.
  links: Record<string, { characterName: string; surname: string | null }>;
}

// Keeps the first and last rows and both rows around every change, dropping the middle of
// plateaus. Drawn as straight segments, that is the same line as every day's point.
function compress<T extends [string, ...number[]]>(rows: Snapshot[], point: (r: Snapshot) => T): T[] {
  const points = rows.map(point);
  const value = (p: T | undefined) => (p ? p.slice(1).join(",") : null);
  return points.filter((p, i) => i === 0 || i === points.length - 1 || value(p) !== value(points[i - 1]) || value(p) !== value(points[i + 1]));
}

const cmpName = (a: string, b: string) => a.localeCompare(b);

// `today` minus 7 days, as a UTC YYYY-MM-DD string.
function weekAgo(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 7)).toISOString().slice(0, 10);
}

function buildLeaderboard(byChar: Snapshot[][], current: Set<string>, firsts: Firsts, today: string): Leaderboard {
  const cutoff = weekAgo(today);
  const members = byChar.filter((rows) => current.has(rows[0].name.toLowerCase()));

  const standings: Standing[] = members.map((rows) => {
    const last = rows[rows.length - 1];
    const baseline = rows.filter((r) => r.day <= cutoff).pop() ?? rows[0];
    return {
      name: last.name,
      class: last.classId,
      race: last.race,
      level: last.level,
      reachedOn: (rows.find((r) => r.level === last.level) ?? last).day,
      gained7d: last.level - baseline.level,
    };
  });
  standings.sort((a, b) => b.level - a.level || a.reachedOn.localeCompare(b.reachedOn) || cmpName(a.name, b.name));

  const fastest = standings
    .filter((x) => x.gained7d > 0)
    .sort((a, b) => b.gained7d - a.gained7d || b.level - a.level || cmpName(a.name, b.name))
    .slice(0, 10);

  const classOf = new Map(members.map((rows) => [rows[0].name.toLowerCase(), rows[rows.length - 1].classId]));
  const counts = new Map<string, number>();
  const categories = [
    ...Object.values(firsts.byLevel),
    ...Object.values(firsts.byClassLevel).flatMap((levels) => Object.values(levels)),
    ...Object.values(firsts.byRace),
    ...Object.values(firsts.bySkill),
    ...Object.values(firsts.byPvpRank),
  ];
  for (const c of categories) {
    const first = c.holders[0]?.name.toLowerCase();
    if (first && current.has(first)) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const display = new Map(members.map((rows) => [rows[0].name.toLowerCase(), rows[rows.length - 1].name]));
  const mostFirsts = [...counts]
    .map(([key, count]) => ({ name: display.get(key) as string, class: classOf.get(key) as string, count }))
    .sort((a, b) => b.count - a.count || cmpName(a.name, b.name))
    .slice(0, 10);

  const bySkill: Record<string, SkillEntry[]> = {};
  for (const rows of members) {
    const last = rows[rows.length - 1];
    for (const [id, skill] of Object.entries(last.skills)) {
      if (skill > 0) (bySkill[id] ??= []).push({ name: last.name, class: last.classId, skill });
    }
  }
  const skills = Object.fromEntries(
    Object.entries(bySkill).map(([id, list]) => [id, list.sort((a, b) => b.skill - a.skill || cmpName(a.name, b.name)).slice(0, 3)]),
  );

  return { standings, fastest, mostFirsts, skills };
}

// `snapshots` must be ordered by name, then day (ProgressStore.snapshots()). History is keyed by
// progress name (first name + surname), so a member is current when theirs matches.
export function buildProgress(
  snapshots: Snapshot[],
  milestones: Milestone[],
  members: { characterName: string; surname: string | null }[],
  today: string,
): ProgressReport {
  const links = Object.fromEntries(
    members.map(({ characterName, surname }) => [progressName(characterName, surname).toLowerCase(), { characterName, surname }]),
  );
  const currentNames = Object.keys(links);
  const current = new Set(currentNames);
  const byName = new Map<string, Snapshot[]>();
  for (const s of snapshots) {
    const key = s.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(s);
    byName.set(key, list);
  }

  const series: LevelSeries[] = [];
  const pvp: PvpSeries[] = [];
  for (const rows of byName.values()) {
    const last = rows[rows.length - 1];
    const who = { name: last.name, class: last.classId, race: last.race, current: current.has(last.name.toLowerCase()) };
    series.push({ ...who, levels: compress(rows, (r): [string, number] => [r.day, r.level]) });
    const ranked = rows.filter((r) => r.pvpRank !== null);
    if (!ranked.some((r) => (r.pvpRank ?? 0) > 0 || (r.honorableKills ?? 0) > 0)) continue;
    const latest = ranked[ranked.length - 1];
    pvp.push({
      ...who,
      rank: latest.pvpRank ?? 0,
      highestRank: Math.max(...ranked.map((r) => r.pvpRank ?? 0)),
      honorableKills: latest.honorableKills ?? 0,
      history: compress(ranked, (r): [string, number, number] => [r.day, r.pvpRank ?? 0, r.honorableKills ?? 0]),
    });
  }

  const days = snapshots.map((s) => s.day).sort();
  const races = [...new Set(snapshots.map((s) => s.race).filter((r): r is string => !!r))];
  const firsts = computeFirsts(milestones, currentNames, races);
  const leaderboard = buildLeaderboard([...byName.values()], current, firsts, today);
  return { trackingSince: days[0] ?? null, series, pvp, firsts, leaderboard, links };
}

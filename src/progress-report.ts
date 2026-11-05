import { computeFirsts, type Firsts } from "./milestones.js";
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

export interface ProgressReport {
  trackingSince: string | null;
  series: LevelSeries[];
  pvp: PvpSeries[];
  firsts: Firsts;
}

// Keeps the first and last rows and both rows around every change, dropping the middle of
// plateaus. Drawn as straight segments, that is the same line as every day's point.
function compress<T extends [string, ...number[]]>(rows: Snapshot[], point: (r: Snapshot) => T): T[] {
  const points = rows.map(point);
  const value = (p: T | undefined) => (p ? p.slice(1).join(",") : null);
  return points.filter((p, i) => i === 0 || i === points.length - 1 || value(p) !== value(points[i - 1]) || value(p) !== value(points[i + 1]));
}

// `snapshots` must be ordered by name, then day (ProgressStore.snapshots()).
export function buildProgress(snapshots: Snapshot[], milestones: Milestone[], currentNames: string[]): ProgressReport {
  const current = new Set(currentNames.map((n) => n.toLowerCase()));
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
  return { trackingSince: days[0] ?? null, series, pvp, firsts: computeFirsts(milestones, currentNames, races) };
}

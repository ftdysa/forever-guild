import { CLASSES, findClass, PROFESSIONS } from "./game-data.js";
import type { Milestone, MilestoneKind, NewMilestone, Snapshot } from "./progress-store.js";

export const MAX_LEVEL = 60;
// Profession skill milestones: the rank caps (Apprentice, Journeyman, Expert, Artisan).
export const SKILL_TIERS = [75, 150, 225, 300];
const SKILL_KEYS = SKILL_TIERS.map(String);
export const PVP_RANKS = 14;
const HOLDERS = 3;
// Level thresholds tracked as milestones. Only the last has a Legacy achievement to backfill from.
export const LEVEL_MILESTONES = [10, 20, 30, 40, 50, 60];
const LEVEL_KEYS = LEVEL_MILESTONES.map(String);
const LEVEL_KEY = String(MAX_LEVEL);

// What a milestone achievement proves. classId is set for "Master <Class>" (level 60 on that class).
export interface MilestoneDef {
  kind: MilestoneKind;
  key: string;
  classId: string | null;
}

// A completed milestone achievement. Account-wide: it may have been earned on another character.
export interface AchievementMilestone extends MilestoneDef {
  completedAt: string;
}

export interface CharacterState {
  classId: string;
  race: string | null;
  level: number;
  skills: Record<string, number>;
  pvpRank: number | null;
}

// Skill milestone key: "<professionId>:<tier>", e.g. "alchemy:150".
export const skillKey = (professionId: string, tier: number | string): string => `${professionId}:${tier}`;
const parseSkillKey = (key: string): [string, number] => {
  const i = key.lastIndexOf(":");
  return [key.slice(0, i), Number(key.slice(i + 1))];
};

// Identifies a milestone across kinds, e.g. "level:30" or "skill:alchemy:150".
export const milestoneId = (m: { kind: MilestoneKind; key: string }): string => `${m.kind}:${m.key}`;

export function milestonesMet(s: CharacterState): { kind: MilestoneKind; key: string }[] {
  const out: { kind: MilestoneKind; key: string }[] = [];
  for (const n of LEVEL_MILESTONES) if (s.level >= n) out.push({ kind: "level", key: String(n) });
  for (const p of PROFESSIONS) {
    for (const n of SKILL_TIERS) if ((s.skills[p.id] ?? 0) >= n) out.push({ kind: "skill", key: skillKey(p.id, n) });
  }
  for (let r = 1; r <= Math.min(s.pvpRank ?? 0, PVP_RANKS); r++) out.push({ kind: "pvp_rank", key: String(r) });
  return out;
}

// When a level or skill milestone was crossed: after `below` (the character's latest earlier-day
// snapshot showing them under it) and by `reached` (their earliest later snapshot at or above it;
// today's row at the latest, null only if today's row is missing).
export interface Bracket {
  below: Snapshot;
  reached: Snapshot | null;
}

export interface DetectInput {
  name: string;
  state: CharacterState;
  // The character's latest snapshot from an earlier day (not today's). PvP compares against it.
  prior: Snapshot | null;
  // Per level/skill milestone id (milestoneId) the character meets; missing when no earlier
  // snapshot shows them under it. History predating a milestone's introduction still brackets
  // it, so a deploy dates old crossings from snapshots instead of today.
  brackets: Record<string, Bracket>;
  // On the roster when tracking began (first snapshot day == tracking start).
  launchMember: boolean;
  existing: Pick<Milestone, "kind" | "key">[];
  achievements: AchievementMilestone[];
  lastLogin: string | null;
  now: string;
}

// Where a level or skill milestone stands in a snapshot: its value, or null when the snapshot
// can't tell (skills are only known once the armory has been read, which sets race).
function progressIn(m: { kind: MilestoneKind; key: string }, s: Snapshot): { value: number; threshold: number } | null {
  if (m.kind === "level") return { value: s.level, threshold: Number(m.key) };
  if (m.kind !== "skill" || s.race === null) return null;
  const [profession, tier] = parseSkillKey(m.key);
  return { value: s.skills[profession] ?? 0, threshold: tier };
}

// Brackets for every level and skill milestone `state` meets, from the character's snapshots
// (oldest first, today's row included). Only days before `today` can show them below it.
export function bracketsFor(state: CharacterState, history: Snapshot[], today: string): Record<string, Bracket> {
  const out: Record<string, Bracket> = {};
  for (const m of milestonesMet(state)) {
    if (m.kind === "pvp_rank") continue;
    const isBelow = (s: Snapshot) => {
      const p = progressIn(m, s);
      return !!p && p.value < p.threshold;
    };
    const below = history.filter((s) => s.day < today && isBelow(s)).pop();
    if (!below) continue;
    const reached = history.find((s) => {
      const p = s.day > below.day && progressIn(m, s);
      return !!p && p.value >= p.threshold;
    });
    out[milestoneId(m)] = { below, reached: reached ?? null };
  }
  return out;
}

// The earlier snapshot a milestone is compared against: levels and skills use their bracket,
// PvP the latest earlier snapshot.
function comparison(kind: MilestoneKind, key: string, i: DetectInput): Snapshot | null {
  return kind === "pvp_rank" ? i.prior : (i.brackets[milestoneId({ kind, key })]?.below ?? null);
}

// True when the comparison snapshot shows the character below this milestone. Skills and PvP are
// only known once the armory has been read (race is set by that read).
function wasBelow(kind: MilestoneKind, key: string, snap: Snapshot | null): boolean {
  if (!snap) return false;
  if (kind === "pvp_rank") return snap.race !== null && (snap.pvpRank ?? 0) < Number(key);
  const p = progressIn({ kind, key }, snap);
  return !!p && p.value < p.threshold;
}

// The UTC day a milestone was first seen met: for levels and skills, the first snapshot at or
// above it (today if there is none); PvP is only seen by today's armory read.
export function crossingDay(m: { kind: MilestoneKind; key: string }, i: Pick<DetectInput, "brackets" | "now">): string {
  const at = m.kind === "pvp_rank" ? null : i.brackets[milestoneId(m)]?.reached;
  return at?.day ?? i.now.slice(0, 10);
}

// Data only changes when someone plays, so the last login is the session it happened in when it
// falls between the comparison snapshot and the day the milestone was first seen. Otherwise a
// level or skill is dated to the start of that day (a re-read of old history must not move it to
// today), and PvP to now.
function observedAt(kind: MilestoneKind, key: string, i: DetectInput, snap: Snapshot): string {
  const seen = crossingDay({ kind, key }, i);
  const ok = i.lastLogin && i.lastLogin >= `${snap.day}T00:00:00.000Z` && i.lastLogin <= `${seen}T23:59:59.999Z` && i.lastLogin <= i.now;
  if (ok) return i.lastLogin as string;
  return kind === "pvp_rank" ? i.now : `${seen}T00:00:00.000Z`;
}

// Achievements are account-wide, so a date is only trusted when this character meets the
// milestone now (true for everything detectMilestones looks at) and, for "Master <Class>",
// plays that class.
function achievedAt(kind: MilestoneKind, key: string, i: DetectInput): string | null {
  const a = i.achievements.find((x) => x.kind === kind && x.key === key && (x.classId === null || x.classId === i.state.classId));
  return a && a.completedAt <= i.now ? a.completedAt : null;
}

// Milestones the character meets now and has no record of yet, each with its source and date.
export function detectMilestones(i: DetectInput): NewMilestone[] {
  const have = new Set(i.existing.map(milestoneId));
  return milestonesMet(i.state)
    .filter((m) => !have.has(milestoneId(m)))
    .map(({ kind, key }): NewMilestone => {
      const base = { name: i.name, kind, key, classId: i.state.classId, race: i.state.race };
      const snap = comparison(kind, key, i);
      if (snap && wasBelow(kind, key, snap)) return { ...base, source: "observed", reachedAt: observedAt(kind, key, i, snap) };
      if (!i.launchMember) return { ...base, source: "before_joining", reachedAt: null };
      const at = achievedAt(kind, key, i);
      return at ? { ...base, source: "achievement", reachedAt: at } : { ...base, source: "before_tracking", reachedAt: null };
    });
}

export interface Holder {
  name: string;
  classId: string;
  current: boolean;
  reachedAt: string;
  source: "observed" | "achievement";
}

export interface Category {
  // Earliest first, at most three.
  holders: Holder[];
  // Already past it when tracking began, date unknown.
  atLaunch: string[];
}

export interface Firsts {
  // Keyed by level milestone ("10" ... "60"); byClassLevel is class id, then level key.
  byLevel: Record<string, Category>;
  byClassLevel: Record<string, Record<string, Category>>;
  byRace: Record<string, Category>;
  // Profession id, then skill tier ("75" ... "300").
  bySkill: Record<string, Record<string, Category>>;
  byPvpRank: Record<string, Category>;
}

const byName = (a: string, b: string) => a.localeCompare(b);

function category(rows: Milestone[], current: Set<string>): Category {
  const dated = rows
    .filter((m) => m.reachedAt !== null && (m.source === "observed" || m.source === "achievement"))
    .sort((a, b) => (a.reachedAt as string).localeCompare(b.reachedAt as string) || byName(a.name, b.name));
  return {
    holders: dated.slice(0, HOLDERS).map((m) => ({
      name: m.name,
      classId: m.classId,
      current: current.has(m.name.toLowerCase()),
      reachedAt: m.reachedAt as string,
      source: m.source as Holder["source"],
    })),
    atLaunch: rows.filter((m) => m.source === "before_tracking").map((m) => m.name).sort(byName),
  };
}

const isLevel = (m: Pick<Milestone, "kind" | "key">, key: string) => m.kind === "level" && m.key === key;

// Guild firsts per category. before_joining rows (arrived already past it) never count.
// `races`: races to list even when unclaimed (e.g. every race seen in a snapshot).
export function computeFirsts(all: Milestone[], currentNames: string[] = [], races: string[] = []): Firsts {
  const current = new Set(currentNames.map((n) => n.toLowerCase()));
  const of = (pred: (m: Milestone) => boolean) => category(all.filter(pred), current);
  const sixties = all.filter((m) => isLevel(m, LEVEL_KEY));
  const raceKeys = [...new Set([...races, ...sixties.map((m) => m.race).filter((r): r is string => !!r)])].sort(byName);
  return {
    byLevel: Object.fromEntries(LEVEL_KEYS.map((k) => [k, of((m) => isLevel(m, k))])),
    byClassLevel: Object.fromEntries(
      CLASSES.map((c) => [c.id, Object.fromEntries(LEVEL_KEYS.map((k) => [k, of((m) => isLevel(m, k) && m.classId === c.id)]))]),
    ),
    byRace: Object.fromEntries(raceKeys.map((r) => [r, of((m) => isLevel(m, LEVEL_KEY) && m.race === r)])),
    bySkill: Object.fromEntries(
      PROFESSIONS.map((p) => [p.id, Object.fromEntries(SKILL_KEYS.map((t) => [t, of((m) => m.kind === "skill" && m.key === skillKey(p.id, t))]))]),
    ),
    byPvpRank: Object.fromEntries(
      Array.from({ length: PVP_RANKS }, (_, i) => String(i + 1)).map((r) => [r, of((m) => m.kind === "pvp_rank" && m.key === r)]),
    ),
  };
}

// Labels for the categories `m` now leads, for the Discord announcement. With `before` (the
// firsts before `m` was recorded), a category that already had a dated holder is not claimed:
// each category is announced once, however later records re-sort it.
export function claimedFirsts(m: Pick<Milestone, "name" | "kind" | "key" | "classId" | "race">, firsts: Firsts, before?: Firsts): string[] {
  const leads = (cat: (f: Firsts) => Category | undefined) =>
    cat(firsts)?.holders[0]?.name.toLowerCase() === m.name.toLowerCase() && !(before && cat(before)?.holders.length);
  if (m.kind === "level") {
    const overall = leads((f) => f.byLevel[m.key]) && `First to reach level ${m.key}`;
    // Class and race firsts are announced for level 60 only; lower ones just show on the site.
    if (m.key !== LEVEL_KEY) return overall ? [overall] : [];
    return [
      overall,
      leads((f) => f.byClassLevel[m.classId]?.[m.key]) && `First ${findClass(m.classId)?.name ?? m.classId} to reach level 60`,
      m.race && leads((f) => f.byRace[m.race as string]) && `First ${m.race} to reach level 60`,
    ].filter((s): s is string => !!s);
  }
  if (m.kind === "skill") {
    const [id, tier] = parseSkillKey(m.key);
    const name = PROFESSIONS.find((p) => p.id === id)?.name ?? id;
    return leads((f) => f.bySkill[id]?.[tier]) ? [`First to reach ${tier} ${name}`] : [];
  }
  return leads((f) => f.byPvpRank[m.key]) ? [`First to reach PvP rank ${m.key}`] : [];
}

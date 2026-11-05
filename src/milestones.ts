import { CLASSES, findClass, PROFESSIONS } from "./game-data.js";
import type { Milestone, MilestoneKind, NewMilestone, Snapshot } from "./progress-store.js";

export const MAX_LEVEL = 60;
export const MAX_SKILL = 300;
export const PVP_RANKS = 14;
const HOLDERS = 3;
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

export function milestonesMet(s: CharacterState): { kind: MilestoneKind; key: string }[] {
  const out: { kind: MilestoneKind; key: string }[] = [];
  if (s.level >= MAX_LEVEL) out.push({ kind: "level", key: LEVEL_KEY });
  for (const p of PROFESSIONS) if ((s.skills[p.id] ?? 0) >= MAX_SKILL) out.push({ kind: "skill", key: p.id });
  for (let r = 1; r <= Math.min(s.pvpRank ?? 0, PVP_RANKS); r++) out.push({ kind: "pvp_rank", key: String(r) });
  return out;
}

export interface DetectInput {
  name: string;
  state: CharacterState;
  // The character's latest snapshot from an earlier day (not today's).
  prior: Snapshot | null;
  // On the roster when tracking began (first snapshot day == tracking start).
  launchMember: boolean;
  existing: Pick<Milestone, "kind" | "key">[];
  achievements: AchievementMilestone[];
  lastLogin: string | null;
  now: string;
}

// True when the earlier snapshot shows the character below this milestone. Skills and PvP are
// only known once the armory has been read (race is set by that read).
function wasBelow(kind: MilestoneKind, key: string, prior: Snapshot | null): boolean {
  if (!prior) return false;
  if (kind === "level") return prior.level < MAX_LEVEL;
  if (prior.race === null) return false;
  if (kind === "skill") return (prior.skills[key] ?? 0) < MAX_SKILL;
  return (prior.pvpRank ?? 0) < Number(key);
}

// Data only changes when someone plays, so the last login is the session it happened in. Ignore it
// if it predates the earlier snapshot or is in the future.
function observedAt(i: DetectInput): string {
  const ok = i.lastLogin && i.prior && i.lastLogin >= `${i.prior.day}T00:00:00.000Z` && i.lastLogin <= i.now;
  return ok ? (i.lastLogin as string) : i.now;
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
  const have = new Set(i.existing.map((m) => `${m.kind}:${m.key}`));
  return milestonesMet(i.state)
    .filter((m) => !have.has(`${m.kind}:${m.key}`))
    .map(({ kind, key }): NewMilestone => {
      const base = { name: i.name, kind, key, classId: i.state.classId, race: i.state.race };
      if (wasBelow(kind, key, i.prior)) return { ...base, source: "observed", reachedAt: observedAt(i) };
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
  overall60: Category;
  byClass: Record<string, Category>;
  byRace: Record<string, Category>;
  bySkill: Record<string, Category>;
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

const isSixty = (m: Pick<Milestone, "kind" | "key">) => m.kind === "level" && m.key === LEVEL_KEY;

// Guild firsts per category. before_joining rows (arrived already past it) never count.
// `races`: races to list even when unclaimed (e.g. every race seen in a snapshot).
export function computeFirsts(all: Milestone[], currentNames: string[] = [], races: string[] = []): Firsts {
  const current = new Set(currentNames.map((n) => n.toLowerCase()));
  const of = (pred: (m: Milestone) => boolean) => category(all.filter(pred), current);
  const sixties = all.filter(isSixty);
  const raceKeys = [...new Set([...races, ...sixties.map((m) => m.race).filter((r): r is string => !!r)])].sort(byName);
  return {
    overall60: of(isSixty),
    byClass: Object.fromEntries(CLASSES.map((c) => [c.id, of((m) => isSixty(m) && m.classId === c.id)])),
    byRace: Object.fromEntries(raceKeys.map((r) => [r, of((m) => isSixty(m) && m.race === r)])),
    bySkill: Object.fromEntries(PROFESSIONS.map((p) => [p.id, of((m) => m.kind === "skill" && m.key === p.id)])),
    byPvpRank: Object.fromEntries(
      Array.from({ length: PVP_RANKS }, (_, i) => String(i + 1)).map((r) => [r, of((m) => m.kind === "pvp_rank" && m.key === r)]),
    ),
  };
}

// Labels for the categories `m` now leads, for the Discord announcement.
export function claimedFirsts(m: Pick<Milestone, "name" | "kind" | "key" | "classId" | "race">, firsts: Firsts): string[] {
  const leads = (c: Category | undefined) => c?.holders[0]?.name.toLowerCase() === m.name.toLowerCase();
  if (m.kind === "level") {
    return [
      leads(firsts.overall60) && "First to reach level 60",
      leads(firsts.byClass[m.classId]) && `First ${findClass(m.classId)?.name ?? m.classId} to reach level 60`,
      m.race && leads(firsts.byRace[m.race]) && `First ${m.race} to reach level 60`,
    ].filter((s): s is string => !!s);
  }
  if (m.kind === "skill") {
    const name = PROFESSIONS.find((p) => p.id === m.key)?.name ?? m.key;
    return leads(firsts.bySkill[m.key]) ? [`First to reach 300 ${name}`] : [];
  }
  return leads(firsts.byPvpRank[m.key]) ? [`First to reach PvP rank ${m.key}`] : [];
}

import type { Member, MemberArmory } from "./db.js";
import { SWEAT_TIERS } from "./game-data.js";
import { progressName } from "./progress.js";
import type { RecipeIndex } from "./recipe-catalog.js";

// The computed sweat factor: how hard each player (a main plus its alts) is playing, 0–100.
// See docs/superpowers/specs/2026-11-06-sweat-factor-design.md.

export type SweatCategory = "leveling" | "gear" | "professions" | "dungeons" | "pvp" | "reputation" | "legacy" | "questing";
export const SWEAT_CATEGORIES: SweatCategory[] = ["leveling", "gear", "professions", "dungeons", "pvp", "reputation", "legacy", "questing"];

export interface SweatResult {
  score: number;
  tier: string;
  // Points per category, after rescaling and the activity multiplier, to one decimal.
  breakdown: Record<SweatCategory, number>;
  mainId: number;
}

export interface SweatEntry {
  name: string;
  class: string;
  score: number;
  tier: string;
  alts: string[];
}

type Read = (m: Member, armory: MemberArmory, recipes: RecipeIndex | null) => number | null;

interface Metric {
  category: SweatCategory;
  weight: number;
  // percentile: share of the guild at or below the value. fraction: the value is already 0–1.
  scale: "percentile" | "fraction";
  // Account-wide values are the same on every character: the best one counts, alts add nothing.
  accountWide?: boolean;
  read: Read;
}

const MAX_SKILL = 300;
const PROFESSION_SLOTS = 5; // 2 primary + 3 secondary
const MAX_PVP_RANK = 14;
const ALT_SHARE = 0.25;
const DAY_MS = 86_400_000;

function skillFraction(m: Member, a: MemberArmory): number {
  const total = [...m.primaryProfessions, ...m.secondaryProfessions].reduce(
    (sum, p) => sum + Math.min(a.skills[p]?.skill ?? 0, MAX_SKILL) / MAX_SKILL,
    0,
  );
  return total / PROFESSION_SLOTS;
}

// Mean over learned primaries in the catalog of known ÷ total recipes; null if none qualify.
function recipeFraction(m: Member, a: MemberArmory, recipes: RecipeIndex | null): number | null {
  if (!recipes) return null;
  const learned = m.primaryProfessions.filter((p) => (recipes.totals[p] ?? 0) > 0);
  if (learned.length === 0) return null;
  const known = new Map<string, number>();
  for (const id of a.recipes ?? []) {
    const p = recipes.professionOf.get(id);
    if (p) known.set(p, (known.get(p) ?? 0) + 1);
  }
  return learned.reduce((sum, p) => sum + Math.min(1, (known.get(p) ?? 0) / recipes.totals[p]), 0) / learned.length;
}

const METRICS: Metric[] = [
  { category: "leveling", weight: 20, scale: "percentile", read: (m) => m.level },
  { category: "gear", weight: 10, scale: "percentile", read: (_m, a) => a.itemLevel },
  { category: "professions", weight: 12, scale: "fraction", read: skillFraction },
  { category: "professions", weight: 8, scale: "fraction", read: recipeFraction },
  { category: "dungeons", weight: 7, scale: "percentile", read: (_m, a) => a.sweatStats?.dungeonsEntered ?? null },
  {
    category: "dungeons",
    weight: 8,
    scale: "percentile",
    read: (_m, a) => (a.sweatStats ? a.sweatStats.dungeonBossKills + 3 * a.sweatStats.raidBossKills : null),
  },
  { category: "pvp", weight: 6, scale: "percentile", read: (_m, a) => a.pvp?.honorableKills ?? null },
  { category: "pvp", weight: 4, scale: "fraction", read: (_m, a) => (a.pvp ? Math.min(a.pvp.rank, MAX_PVP_RANK) / MAX_PVP_RANK : null) },
  {
    category: "reputation",
    weight: 5,
    scale: "percentile",
    read: (_m, a) => (a.sweatStats ? a.sweatStats.exalted + 0.1 * a.sweatStats.factionsEncountered : null),
  },
  { category: "legacy", weight: 10, scale: "percentile", accountWide: true, read: (_m, a) => a.legacy?.earned ?? null },
  { category: "questing", weight: 10, scale: "percentile", read: (_m, a) => a.sweatStats?.questsCompleted ?? null },
];

// Inclusive percentile among the known values; 0 always scores 0 (nobody exalted ≠ everyone tops it).
function percentile(value: number, population: number[]): number {
  if (value <= 0) return 0;
  return population.filter((v) => v <= value).length / population.length;
}

export function activityMultiplier(lastLogin: string | null, now: number): number {
  if (!lastLogin) return 1;
  const days = (now - Date.parse(lastLogin)) / DAY_MS;
  if (days <= 3) return 1;
  if (days <= 7) return 0.9;
  if (days <= 14) return 0.75;
  if (days <= 30) return 0.5;
  return 0.25;
}

export function tierFor(score: number): string {
  let tier = SWEAT_TIERS[0].id;
  for (const t of SWEAT_TIERS) if (score >= t.min) tier = t.id;
  return tier;
}

// Main id → the main followed by its alts. A link to a missing member or to another alt is
// ignored (validation prevents both), leaving that character as its own main.
export function playerGroups(members: Member[]): Map<number, Member[]> {
  const byId = new Map(members.map((m) => [m.id, m]));
  const mainOf = (m: Member) => {
    const main = m.altOf === null ? undefined : byId.get(m.altOf);
    return main && main.altOf === null ? main.id : m.id;
  };
  const groups = new Map<number, Member[]>();
  for (const m of members) if (mainOf(m) === m.id) groups.set(m.id, [m]);
  for (const m of members) if (mainOf(m) !== m.id) groups.get(mainOf(m))?.push(m);
  return groups;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// Scores every player; each of their characters maps to the same result. Members never read
// from the armory are left out of every population; a player with none read has no entry.
export function computeSweat(members: Member[], recipes: RecipeIndex | null, now: number): Map<number, SweatResult> {
  const read = members.filter((m): m is Member & { armory: MemberArmory } => m.armory !== null);
  // Per metric: character id → normalized 0–1 value, or null when unknown.
  const normalized = METRICS.map((metric) => {
    const raw = new Map(read.map((m) => [m.id, metric.read(m, m.armory, recipes)]));
    const population = [...raw.values()].filter((v): v is number => v !== null);
    return new Map(
      [...raw].map(([id, v]) => [id, v === null ? null : metric.scale === "fraction" ? v : percentile(v, population)]),
    );
  });

  const out = new Map<number, SweatResult>();
  for (const [mainId, group] of playerGroups(members)) {
    const values = METRICS.map((metric, i) => {
      const vals = group
        .map((m) => normalized[i].get(m.id))
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => b - a);
      if (vals.length === 0) return null;
      if (metric.accountWide) return vals[0];
      return Math.min(1, vals[0] + ALT_SHARE * vals.slice(1).reduce((s, v) => s + v, 0));
    });
    const known = METRICS.reduce((s, metric, i) => s + (values[i] === null ? 0 : metric.weight), 0);
    if (known === 0) continue;
    const lastLogin =
      group
        .map((m) => m.armory?.lastLogin ?? null)
        .filter((d): d is string => d !== null)
        .sort()
        .pop() ?? null;
    const scale = (100 / known) * activityMultiplier(lastLogin, now);
    const breakdown = Object.fromEntries(SWEAT_CATEGORIES.map((c) => [c, 0])) as Record<SweatCategory, number>;
    let total = 0;
    METRICS.forEach((metric, i) => {
      const v = values[i];
      if (v === null) return;
      const points = metric.weight * v * scale;
      breakdown[metric.category] += points;
      total += points;
    });
    for (const c of SWEAT_CATEGORIES) breakdown[c] = round1(breakdown[c]);
    const score = Math.round(total);
    const result = { score, tier: tierFor(score), breakdown, mainId };
    for (const m of group) out.set(m.id, result);
  }
  return out;
}

// Top players by score (ties by name), named like the rest of the progress tab.
export function sweatLeaderboard(members: Member[], results: Map<number, SweatResult>, limit = 10): SweatEntry[] {
  const name = (m: Member) => progressName(m.characterName, m.surname);
  return [...playerGroups(members)]
    .flatMap(([mainId, [main, ...alts]]) => {
      const r = results.get(mainId);
      return r ? [{ name: name(main), class: main.mainClass, score: r.score, tier: r.tier, alts: alts.map(name) }] : [];
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

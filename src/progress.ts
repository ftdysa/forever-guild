import type { CharacterInfo } from "./armory.js";
import type { Member, RosterMember } from "./db.js";
import type { DiscordNotifier } from "./discord.js";
import { claimedFirsts, computeFirsts, crossingDay, detectMilestones, LEVEL_MILESTONES } from "./milestones.js";
import { utcDay, type ProgressStore, type SnapshotPatch } from "./progress-store.js";

const DAY_MS = 86_400_000;
const FRESH_DAYS = 2;

// History key for a character: Forever first names aren't unique, so the surname is part of it.
export const progressName = (characterName: string, surname: string | null): string =>
  surname ? `${characterName} ${surname}` : characterName;

// Writes the guild sync's view of each character into daily snapshots, records milestones as
// they are crossed, and announces new guild firsts.
export class ProgressRecorder {
  constructor(
    private store: ProgressStore,
    private notifier: Pick<DiscordNotifier, "guildFirsts"> | null,
    private now: () => number = Date.now,
  ) {}

  // Every member's level and class, straight from the roster (so members below 10 are tracked).
  recordRoster(roster: RosterMember[]): void {
    this.store.upsertSnapshots(
      utcDay(this.now()),
      roster.map((r) => ({ name: progressName(r.name, r.surname), patch: { classId: r.classId, level: r.level } })),
    );
  }

  // One character's armory read: race, PvP and skills, then any milestones it shows.
  async recordArmory(m: Member, c: CharacterInfo): Promise<void> {
    const nowMs = this.now();
    const day = utcDay(nowMs);
    const name = progressName(m.characterName, m.surname);
    const skills = c.professions ? Object.fromEntries(Object.entries(c.professions.skills).map(([p, s]) => [p, s.skill])) : null;
    const patch: SnapshotPatch = {
      classId: m.mainClass,
      ...(c.race ? { race: c.race } : {}),
      ...(c.pvp ? { pvpRank: c.pvp.rank, honorableKills: c.pvp.honorableKills } : {}),
      ...(skills ? { skills } : {}),
    };
    // Read before writing today's row: detection compares against earlier days only.
    const prior = this.store.latestBefore(name, day);
    this.store.upsertSnapshot(name, day, patch);
    const today = this.store.get(name, day);
    if (!today) return;

    const level = Math.max(m.level, c.level);
    // Per threshold the character meets now: the last earlier-day snapshot below it, and the first
    // later one at or above it (today's row at the latest), bracketing when it was crossed.
    const met = LEVEL_MILESTONES.filter((n) => level >= n).map((n) => [String(n), n, this.store.latestBelowLevel(name, day, n)] as const);
    const priorBelowLevel = Object.fromEntries(met.map(([k, , below]) => [k, below]));
    const firstAtOrAboveLevel = Object.fromEntries(met.map(([k, n, below]) => [k, below && this.store.firstAtOrAbove(name, below.day, n)]));
    const input = {
      name,
      state: { classId: m.mainClass, race: today.race, level, skills: today.skills, pvpRank: today.pvpRank },
      prior,
      priorBelowLevel,
      firstAtOrAboveLevel,
      launchMember: this.store.firstDay(name) === this.store.trackingSince(),
      existing: this.store.milestonesFor(name),
      achievements: c.milestoneAchievements,
      lastLogin: c.lastLogin,
      now: new Date(nowMs).toISOString(),
    };
    const before = computeFirsts(this.store.milestones());
    const added = detectMilestones(input).filter((x) => this.store.addMilestone(x));

    // Only crossings first seen in the last two days are news; older ones (history re-read after
    // a deploy, or a long armory outage) are recorded silently.
    const freshFrom = utcDay(nowMs - FRESH_DAYS * DAY_MS);
    const observed = added.filter((x) => x.source === "observed" && crossingDay(x, input) >= freshFrom);
    if (observed.length === 0) return;
    const firsts = computeFirsts(this.store.milestones());
    const claiming = observed.map((x) => ({ x, claims: claimedFirsts(x, firsts, before) })).filter((e) => e.claims.length > 0);
    if (claiming.length === 0) return;
    for (const { x } of claiming) this.store.markAnnounced(x.name, x.kind, x.key);
    await this.notifier?.guildFirsts(
      { name: m.characterName, surname: m.surname, classId: m.mainClass },
      claiming.flatMap((e) => e.claims),
      claiming[0].x.reachedAt ?? new Date(nowMs).toISOString(),
    );
  }
}

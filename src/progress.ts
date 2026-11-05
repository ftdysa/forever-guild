import type { CharacterInfo } from "./armory.js";
import type { Member, RosterMember } from "./db.js";
import type { DiscordNotifier } from "./discord.js";
import { claimedFirsts, computeFirsts, detectMilestones, LEVEL_MILESTONES } from "./milestones.js";
import { utcDay, type ProgressStore, type SnapshotPatch } from "./progress-store.js";

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
    // One comparison snapshot per threshold the character meets now.
    const priorBelowLevel = Object.fromEntries(
      LEVEL_MILESTONES.filter((n) => level >= n).map((n) => [String(n), this.store.latestBelowLevel(name, day, n)]),
    );
    const added = detectMilestones({
      name,
      state: { classId: m.mainClass, race: today.race, level, skills: today.skills, pvpRank: today.pvpRank },
      prior,
      priorBelowLevel,
      launchMember: this.store.firstDay(name) === this.store.trackingSince(),
      existing: this.store.milestonesFor(name),
      achievements: c.milestoneAchievements,
      lastLogin: c.lastLogin,
      now: new Date(nowMs).toISOString(),
    }).filter((x) => this.store.addMilestone(x));

    const observed = added.filter((x) => x.source === "observed");
    if (observed.length === 0) return;
    const firsts = computeFirsts(this.store.milestones());
    const claiming = observed.map((x) => ({ x, claims: claimedFirsts(x, firsts) })).filter((e) => e.claims.length > 0);
    if (claiming.length === 0) return;
    for (const { x } of claiming) this.store.markAnnounced(x.name, x.kind, x.key);
    await this.notifier?.guildFirsts(
      { name: m.characterName, surname: m.surname, classId: m.mainClass },
      claiming.flatMap((e) => e.claims),
      claiming[0].x.reachedAt ?? new Date(nowMs).toISOString(),
    );
  }
}

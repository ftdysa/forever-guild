import type { CharacterInfo } from "./armory.js";
import type { Member, RosterMember } from "./db.js";
import type { DiscordNotifier } from "./discord.js";
import { claimedFirsts, computeFirsts, detectMilestones, MAX_LEVEL } from "./milestones.js";
import { utcDay, type ProgressStore, type SnapshotPatch } from "./progress-store.js";

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
      roster.map((r) => ({ name: r.name, patch: { classId: r.classId, level: r.level } })),
    );
  }

  // One character's armory read: race, PvP and skills, then any milestones it shows.
  async recordArmory(m: Member, c: CharacterInfo): Promise<void> {
    const nowMs = this.now();
    const day = utcDay(nowMs);
    const name = m.characterName;
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

    const added = detectMilestones({
      name,
      state: { classId: m.mainClass, race: today.race, level: Math.max(m.level, c.level), skills: today.skills, pvpRank: today.pvpRank },
      prior,
      priorBelowLevel: this.store.latestBelowLevel(name, day, MAX_LEVEL),
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
      { name, surname: m.surname, classId: m.mainClass },
      claiming.flatMap((e) => e.claims),
      claiming[0].x.reachedAt ?? new Date(nowMs).toISOString(),
    );
  }
}

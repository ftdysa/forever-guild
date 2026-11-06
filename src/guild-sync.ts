import type { FastifyBaseLogger } from "fastify";
import { mapLimit } from "./concurrency.js";
import { ROSTER_TTL_MS, type ArmoryService, type CharacterInfo } from "./armory.js";
import { BlizzardError } from "./blizzard.js";
import type { Member, MemberArmory, MemberStore, RosterMember } from "./db.js";
import type { DiscordNotifier } from "./discord.js";
import type { ProgressRecorder } from "./progress.js";

// Every member's spec and professions are re-read once per roster refresh (each sync tick). Character lookups are
// cached and revalidated with one conditional call, so refreshing unchanged characters is cheap.
const REFRESH_MS = ROSTER_TTL_MS;
// Characters read from the armory at once. Each is one parallel round of profile calls (or a
// single 304 when unchanged), so this caps in-flight Blizzard requests at roughly 4 × 10.
const ENRICH_CONCURRENCY = 4;

// A failed statistics call reads as null; keep what the member already had until it succeeds again.
function snapshot(c: CharacterInfo, m: Member): MemberArmory {
  return {
    race: c.race,
    gender: c.gender,
    faction: c.faction,
    title: c.title,
    itemLevel: c.itemLevel,
    lastLogin: c.lastLogin,
    achievementPoints: c.achievementPoints,
    legacy: c.legacy,
    skills: c.professions?.skills ?? {},
    recipes: c.professions?.recipes ?? [],
    pvp: c.pvp,
    sweatStats: c.sweatStats ?? m.armory?.sweatStats ?? null,
  };
}

// Keeps the members table in step with the guild roster.
//
// sync() resolves once the roster itself is applied (one cached Blizzard call). Reading each
// newcomer's spec and professions, announcing them, and the periodic refresh of everyone else
// happen afterwards in the background; idle() waits for that (tests, shutdown).
export class GuildSync {
  private pending: Promise<void> | null = null;
  private background: Promise<void> = Promise.resolve();
  private refreshedAt = -Infinity;

  constructor(
    private armory: ArmoryService,
    private store: MemberStore,
    private notifier: DiscordNotifier | null,
    private log: FastifyBaseLogger,
    private now: () => number = Date.now,
    private progress: ProgressRecorder | null = null,
  ) {}

  // Concurrent callers share one run. Rejects with BlizzardError when the roster can't be read.
  sync(): Promise<void> {
    this.pending ??= this.run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  idle(): Promise<void> {
    return this.background;
  }

  private async run(): Promise<void> {
    // Classes we don't model (none on Forever today) can't be placed on the roster.
    const roster = (await this.armory.roster()).filter((r): r is RosterMember => r.classId !== null);
    // The first sync fills an empty table; announcing the whole guild would spam Discord.
    const seeding = this.store.list().length === 0;
    const added = this.store.syncRoster(roster);
    try {
      this.progress?.recordRoster(roster);
    } catch (err) {
      this.log.warn({ err }, "progress snapshot failed");
    }
    this.background = this.background
      .then(() => this.afterSync(added, seeding))
      .catch((err: unknown) => this.log.error({ err }, "guild sync background work failed"));
  }

  private async afterSync(added: Member[], seeding: boolean): Promise<void> {
    await mapLimit(added, ENRICH_CONCURRENCY, (m) => this.enrich(m));
    // Seeding just read everyone, so the refresh below has nothing new to find.
    if (seeding) this.refreshedAt = this.now();
    if (!seeding && this.notifier) {
      for (const m of added) await this.notifier.memberJoined(this.store.get(m.id) ?? m);
    }
    if (this.now() - this.refreshedAt < REFRESH_MS) return;
    this.refreshedAt = this.now();
    await mapLimit(this.store.list(), ENRICH_CONCURRENCY, (m) => this.enrich(m));
  }

  // One character's spec and professions. Failures are logged and retried on the next refresh.
  private async enrich(m: Member): Promise<void> {
    try {
      // The full lookup (not just specs and professions) also warms the cache the armory dialog reads.
      const c = await this.armory.character(m.characterName, m.surname);
      if (!c) return;
      this.store.applyArmory(m, {
        spec: c.spec?.specId ?? null,
        // null: this flavour's armory has no professions (Classic Era), so keep what we have.
        primary: c.professions?.primary ?? m.primaryProfessions,
        secondary: c.professions?.secondary ?? m.secondaryProfessions,
        armory: snapshot(c, m),
      });
      // History must never break the roster refresh.
      await this.progress?.recordArmory(m, c).catch((err: unknown) => {
        this.log.warn({ character: m.characterName, err }, "progress recording failed");
      });
    } catch (err) {
      if (!(err instanceof BlizzardError)) throw err;
      this.log.warn({ character: m.characterName, err: err.message }, "armory refresh failed");
    }
  }
}

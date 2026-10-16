import type { BlizzardConfig } from "./config.js";
import type { ArmoryCache } from "./db.js";
import { BlizzardError, type BlizzardClient } from "./blizzard.js";
import { findSpec, PROFESSIONS } from "./game-data.js";

// Blizzard playable-class ids → our class ids (classes missing here are not in the game data).
const CLASS_BY_BLIZZARD_ID: Record<number, string> = {
  1: "warrior",
  2: "paladin",
  3: "hunter",
  4: "rogue",
  5: "priest",
  7: "shaman",
  8: "mage",
  9: "warlock",
  11: "druid",
};

const ROSTER_TTL_MS = 6 * 60 * 60 * 1000;
const CHARACTER_TTL_MS = 3 * 60 * 60 * 1000;
const AVATAR_HOST = "render.worldofwarcraft.com";

export interface RosterEntry {
  name: string;
  level: number;
  classId: string | null;
  rank: number;
}

export interface GearItem {
  slot: string;
  name: string;
  quality: string;
  itemId: number;
}

export interface CharacterInfo {
  name: string;
  level: number;
  classId: string | null;
  race: string | null;
  guild: string | null;
  itemLevel: number | null;
  lastLogin: string | null;
  avatarUrl: string | null;
  // Spec inferred from where talent points are spent; a suggestion, not a fact.
  spec: { specId: string; points: Record<string, number> } | null;
  // null when the realm's API has no professions endpoint (e.g. Classic Era).
  professions: { primary: string[]; secondary: string[] } | null;
  gear: GearItem[];
}

// --- Raw Blizzard shapes (only the fields we read) ---
interface RawRoster {
  members: { character: { name: string; level: number; playable_class: { id: number } }; rank: number }[];
}
interface RawSummary {
  name: string;
  level: number;
  character_class?: { id: number };
  race?: { name?: string };
  guild?: { name?: string };
  equipped_item_level?: number;
  last_login_timestamp?: number;
}
interface RawEquipment {
  equipped_items?: { slot: { name: string }; name: string; quality: { type: string }; item: { id: number } }[];
}
export interface RawSpecializations {
  specialization_groups?: {
    is_active?: boolean;
    specializations?: { specialization_name: string; spent_points: number }[];
  }[];
}
interface RawMedia {
  assets?: { key: string; value: string }[];
}
export interface RawProfessions {
  primaries?: { profession: { name: string } }[];
  secondaries?: { profession: { name: string } }[];
}

const slug = (s: string) => s.toLowerCase().replace(/\s+/g, "-");

// Picks the talent tree with the most points in the active group. Ties and empty builds give null.
export function inferSpec(classId: string | null, raw: RawSpecializations | null): CharacterInfo["spec"] {
  if (!classId || !raw?.specialization_groups?.length) return null;
  const groups = raw.specialization_groups;
  const group = groups.find((g) => g.is_active) ?? groups[0];
  const trees = (group.specializations ?? []).filter((t) => t.spent_points > 0);
  if (trees.length === 0) return null;
  const points = Object.fromEntries(trees.map((t) => [slug(t.specialization_name), t.spent_points]));
  const sorted = [...trees].sort((a, b) => b.spent_points - a.spent_points);
  if (sorted.length > 1 && sorted[0].spent_points === sorted[1].spent_points) return null;
  const specId = slug(sorted[0].specialization_name);
  return findSpec(classId, specId) ? { specId, points } : null;
}

// Maps Blizzard profession names onto our ids, dropping professions we don't track.
export function mapProfessions(raw: RawProfessions | null): CharacterInfo["professions"] {
  if (!raw) return null;
  const pick = (list: RawProfessions["primaries"], kind: "primary" | "secondary") =>
    (list ?? [])
      .map((p) => PROFESSIONS.find((x) => x.kind === kind && x.name.toLowerCase() === p.profession.name.toLowerCase())?.id)
      .filter((id): id is string => id !== undefined);
  return { primary: pick(raw.primaries, "primary").slice(0, 2), secondary: pick(raw.secondaries, "secondary") };
}

function avatarFrom(raw: RawMedia | null): string | null {
  const value = raw?.assets?.find((a) => a.key === "avatar")?.value;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === AVATAR_HOST ? url.href : null;
  } catch {
    return null;
  }
}

export class ArmoryService {
  private keyPrefix: string;

  constructor(
    private client: BlizzardClient,
    private cache: ArmoryCache,
    private cfg: Pick<BlizzardConfig, "region" | "namespace" | "realm" | "guild">,
    private now: () => number = Date.now,
  ) {
    // Keys carry the realm and guild, so pointing at a new guild never serves the old one's data.
    this.keyPrefix = `${cfg.region}:${cfg.namespace}:${cfg.realm}`;
  }

  get settings() {
    return this.cfg;
  }

  roster(): Promise<RosterEntry[]> {
    return this.cached(`${this.keyPrefix}:guild:${this.cfg.guild}`, ROSTER_TTL_MS, async () => {
      const raw = await this.client.profile<RawRoster>(`/data/wow/guild/${this.cfg.realm}/${this.cfg.guild}/roster`);
      if (!raw) throw new BlizzardError("guild not found");
      return raw.members
        .map((m) => ({
          name: m.character.name,
          level: m.character.level,
          classId: CLASS_BY_BLIZZARD_ID[m.character.playable_class.id] ?? null,
          rank: m.rank,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  // `name` must already be validated as letters only.
  character(name: string): Promise<CharacterInfo | null> {
    const lower = name.toLowerCase();
    return this.cached(`${this.keyPrefix}:character:${lower}`, CHARACTER_TTL_MS, async () => {
      const base = `/profile/wow/character/${this.cfg.realm}/${encodeURIComponent(lower)}`;
      const summary = await this.client.profile<RawSummary>(base);
      if (!summary) return null;
      const [equipment, specs, media, professions] = await Promise.all([
        this.client.profile<RawEquipment>(`${base}/equipment`),
        this.client.profile<RawSpecializations>(`${base}/specializations`),
        this.client.profile<RawMedia>(`${base}/character-media`),
        this.client.profile<RawProfessions>(`${base}/professions`),
      ]);
      const classId = summary.character_class ? (CLASS_BY_BLIZZARD_ID[summary.character_class.id] ?? null) : null;
      return {
        name: summary.name,
        level: summary.level,
        classId,
        race: summary.race?.name ?? null,
        guild: summary.guild?.name ?? null,
        itemLevel: summary.equipped_item_level ?? null,
        lastLogin: summary.last_login_timestamp ? new Date(summary.last_login_timestamp).toISOString() : null,
        avatarUrl: avatarFrom(media),
        spec: inferSpec(classId, specs),
        professions: mapProfessions(professions),
        gear: (equipment?.equipped_items ?? []).map((i) => ({
          slot: i.slot.name,
          name: i.name,
          quality: i.quality.type.toLowerCase(),
          itemId: i.item.id,
        })),
      };
    });
  }

  // Serves fresh cache hits; otherwise fetches, falling back to stale data if Blizzard is down.
  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.fetchedAt < ttlMs) return hit.value as T;
    try {
      const value = await load();
      this.cache.set(key, value, this.now());
      return value;
    } catch (err) {
      if (hit && err instanceof BlizzardError) return hit.value as T;
      throw err;
    }
  }
}

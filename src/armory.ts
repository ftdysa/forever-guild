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
// Item icons never change, so keep them for a month.
const ICON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Blizzard's search API caps a page at 100 results; one OR-query fetches that many icons.
const ICON_BATCH = 100;
const AVATAR_HOST = "render.worldofwarcraft.com";

export interface RosterEntry {
  name: string;
  level: number;
  classId: string | null;
  rank: number;
}

export interface GearItem {
  // Blizzard slot type, e.g. HEAD, FINGER_1, MAIN_HAND
  slot: string;
  slotName: string;
  name: string;
  quality: string;
  itemId: number;
  icon: string | null;
  tooltip: ItemTooltip;
}

export interface CharacterStats {
  health: number;
  powerName: string;
  power: number;
  strength: number;
  agility: number;
  stamina: number;
  intellect: number;
  spirit: number;
  // Best of melee / ranged / spell crit, in percent.
  crit: number;
}

// Tooltip lines, using Blizzard's own display strings where it provides them.
export interface ItemTooltip {
  binding: string | null;
  unique: string | null;
  slotLabel: string | null;
  // Armor/weapon type, e.g. "Plate" or "Sword"; null where the game hides it (necks, rings).
  typeLabel: string | null;
  damage: string | null;
  speed: string | null;
  dps: string | null;
  armor: string | null;
  stats: string[];
  enchantments: string[];
  durability: string | null;
  requiredLevel: string | null;
  spells: string[];
  set: { name: string; items: { name: string; equipped: boolean }[]; effects: { text: string; active: boolean }[] } | null;
  description: string | null;
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
  // Full-body transparent render for the paper doll.
  renderUrl: string | null;
  faction: "horde" | "alliance" | null;
  stats: CharacterStats | null;
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
  faction?: { type?: string };
  level: number;
  character_class?: { id: number };
  race?: { name?: string };
  guild?: { name?: string };
  equipped_item_level?: number;
  last_login_timestamp?: number;
}
type Display = { display_string?: string };
export interface RawItem {
  slot: { type: string; name: string };
  name: string;
  quality: { type: string };
  item: { id: number };
  binding?: { name?: string };
  unique_equipped?: string;
  inventory_type?: { name?: string };
  item_subclass?: { name?: string };
  is_subclass_hidden?: boolean;
  armor?: { display?: Display };
  weapon?: { damage?: Display; attack_speed?: Display; dps?: Display };
  stats?: { display?: Display }[];
  enchantments?: Display[];
  durability?: Display;
  requirements?: { level?: Display };
  spells?: { description?: string }[];
  set?: {
    item_set?: { name?: string };
    display_string?: string;
    items?: { item: { name?: string }; is_equipped?: boolean }[];
    effects?: { display_string?: string; required_count?: number }[];
  };
  description?: string;
}
interface RawEquipment {
  equipped_items?: RawItem[];
}
export interface RawSpecializations {
  specialization_groups?: {
    is_active?: boolean;
    specializations?: { specialization_name: string; spent_points: number }[];
  }[];
}
type Attr = { effective?: number };
type Crit = { value?: number };
export interface RawStatistics {
  health?: number;
  power?: number;
  power_type?: { name?: string };
  strength?: Attr;
  agility?: Attr;
  stamina?: Attr;
  intellect?: Attr;
  spirit?: Attr;
  melee_crit?: Crit;
  ranged_crit?: Crit;
  spell_crit?: Crit;
}
interface RawMedia {
  assets?: { key: string; value: string }[];
}
interface RawMediaSearch {
  results?: { data?: RawMedia & { id?: number } }[];
}
export interface RawProfessions {
  primaries?: { profession: { name: string } }[];
  secondaries?: { profession: { name: string } }[];
}

const slug = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
const text = (d: Display | undefined) => d?.display_string ?? null;
const texts = (list: (Display | undefined)[] | undefined) =>
  (list ?? []).map(text).filter((t): t is string => t !== null);

export function mapStats(raw: RawStatistics | null): CharacterStats | null {
  if (!raw || raw.health === undefined) return null;
  const crit = Math.max(raw.melee_crit?.value ?? 0, raw.ranged_crit?.value ?? 0, raw.spell_crit?.value ?? 0);
  return {
    health: raw.health,
    powerName: raw.power_type?.name ?? "Power",
    power: raw.power ?? 0,
    strength: raw.strength?.effective ?? 0,
    agility: raw.agility?.effective ?? 0,
    stamina: raw.stamina?.effective ?? 0,
    intellect: raw.intellect?.effective ?? 0,
    spirit: raw.spirit?.effective ?? 0,
    crit: Math.round(crit * 100) / 100,
  };
}

export function itemTooltip(raw: RawItem): ItemTooltip {
  const set = raw.set;
  const equippedCount = set?.items?.filter((i) => i.is_equipped).length ?? 0;
  return {
    binding: raw.binding?.name ?? null,
    unique: raw.unique_equipped ?? null,
    slotLabel: raw.inventory_type?.name ?? null,
    typeLabel: raw.is_subclass_hidden ? null : (raw.item_subclass?.name ?? null),
    damage: text(raw.weapon?.damage),
    speed: text(raw.weapon?.attack_speed),
    dps: text(raw.weapon?.dps),
    armor: text(raw.armor?.display),
    stats: texts(raw.stats?.map((st) => st.display)),
    enchantments: texts(raw.enchantments),
    durability: text(raw.durability),
    requiredLevel: text(raw.requirements?.level),
    spells: (raw.spells ?? []).map((sp) => sp.description).filter((d): d is string => !!d),
    set: set
      ? {
          name: set.display_string ?? set.item_set?.name ?? "",
          items: (set.items ?? []).map((i) => ({ name: i.item.name ?? "", equipped: !!i.is_equipped })),
          effects: (set.effects ?? [])
            .filter((e) => e.display_string)
            .map((e) => ({ text: e.display_string as string, active: equippedCount >= (e.required_count ?? Infinity) })),
        }
      : null,
    description: raw.description ?? null,
  };
}

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

// Only Blizzard's render CDN is allowed through, matching the page's CSP img-src.
function mediaUrl(raw: RawMedia | null, key: string): string | null {
  const value = raw?.assets?.find((a) => a.key === key)?.value;
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
    // v2: gear carries icons and tooltips; older cached entries lack them.
    return this.cached(`${this.keyPrefix}:character:v2:${lower}`, CHARACTER_TTL_MS, async () => {
      const base = `/profile/wow/character/${this.cfg.realm}/${encodeURIComponent(lower)}`;
      const summary = await this.client.profile<RawSummary>(base);
      if (!summary) return null;
      const [equipment, specs, media, professions, statistics] = await Promise.all([
        this.client.profile<RawEquipment>(`${base}/equipment`),
        this.client.profile<RawSpecializations>(`${base}/specializations`),
        this.client.profile<RawMedia>(`${base}/character-media`),
        // Classic Era has no professions endpoint (always 404), so don't spend a call on it.
        this.cfg.namespace === "classic1x" ? null : this.client.profile<RawProfessions>(`${base}/professions`),
        this.client.profile<RawStatistics>(`${base}/statistics`),
      ]);
      const classId = summary.character_class ? (CLASS_BY_BLIZZARD_ID[summary.character_class.id] ?? null) : null;
      const items = equipment?.equipped_items ?? [];
      const icons = await this.itemIcons(items.map((i) => i.item.id));
      return {
        name: summary.name,
        level: summary.level,
        classId,
        race: summary.race?.name ?? null,
        guild: summary.guild?.name ?? null,
        itemLevel: summary.equipped_item_level ?? null,
        lastLogin: summary.last_login_timestamp ? new Date(summary.last_login_timestamp).toISOString() : null,
        avatarUrl: mediaUrl(media, "avatar"),
        renderUrl: mediaUrl(media, "main-raw"),
        faction: summary.faction?.type === "HORDE" ? "horde" : summary.faction?.type === "ALLIANCE" ? "alliance" : null,
        stats: mapStats(statistics),
        spec: inferSpec(classId, specs),
        professions: mapProfessions(professions),
        gear: items.map((i) => ({
          slot: i.slot.type,
          slotName: i.slot.name,
          name: i.name,
          quality: i.quality.type.toLowerCase(),
          itemId: i.item.id,
          icon: icons.get(i.item.id) ?? null,
          tooltip: itemTooltip(i),
        })),
      };
    });
  }

  // Icon URLs by item id. Cached icons are reused; the rest come from one media search per
  // 100 ids rather than one call per item. Missing or unreachable icons map to null, and the
  // UI shows a blank frame.
  private async itemIcons(ids: number[]): Promise<Map<number, string | null>> {
    const icons = new Map<number, string | null>();
    const key = (id: number) => `${this.cfg.region}:${this.cfg.namespace}:icon:${id}`;
    const missing: number[] = [];
    for (const id of new Set(ids)) {
      const hit = this.cache.get(key(id));
      if (hit && this.now() - hit.fetchedAt < ICON_TTL_MS) icons.set(id, hit.value as string | null);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += ICON_BATCH) {
      const batch = missing.slice(i, i + ICON_BATCH);
      let found: Map<number, string | null>;
      try {
        const raw = await this.client.gameData<RawMediaSearch>("/data/wow/search/media", {
          tags: "item",
          id: batch.join("||"),
          _pageSize: String(ICON_BATCH),
        });
        found = new Map((raw?.results ?? []).map((r) => [r.data?.id ?? 0, mediaUrl(r.data ?? null, "icon")]));
      } catch (err) {
        if (!(err instanceof BlizzardError)) throw err;
        continue; // leave this batch uncached so the next view retries
      }
      for (const id of batch) {
        const icon = found.get(id) ?? null;
        icons.set(id, icon);
        // Cache misses too, so items without an icon aren't searched for on every view.
        this.cache.set(key(id), icon, this.now());
      }
    }
    return icons;
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

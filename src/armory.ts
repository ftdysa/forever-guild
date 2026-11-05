import type { BlizzardConfig } from "./config.js";
import type { ArmoryCache } from "./db.js";
import { BlizzardError, type BlizzardClient } from "./blizzard.js";
import { mapLimit } from "./concurrency.js";
import { CLASSES, findSpec, PROFESSIONS } from "./game-data.js";
import type { AchievementMilestone, MilestoneDef } from "./milestones.js";

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

// The guild roster drives the site's member list (and, on Forever, name-surname slugs), so it is
// refreshed often enough that joins, leaves and level-ups show up quickly.
export const ROSTER_TTL_MS = 15 * 60 * 1000;
// Cached characters are served as-is for this long, then revalidated with one conditional
// request (see character()). There is no hard expiry: unchanged characters stay cached.
const CHARACTER_FRESH_MS = 15 * 60 * 1000;
// Legacy challenge definitions (static game data) change only with patches.
const LEGACY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_REWARD = /legacy point/i;
// Parallel static lookups when discovering Legacy achievements.
const STATIC_CONCURRENCY = 8;
// Item icons effectively never change.
const ICON_TTL_MS = 365 * 24 * 60 * 60 * 1000;
// Blizzard's search API caps a page at 100 results; one OR-query fetches that many icons.
const ICON_BATCH = 100;
const AVATAR_HOST = "render.worldofwarcraft.com";

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

export interface Professions {
  primary: string[];
  secondary: string[];
  // Current and maximum skill by profession id.
  skills: Record<string, { skill: number; max: number }>;
  // Known recipe ids across the professions above (crafting directory).
  recipes: number[];
}

export interface Reputation {
  faction: string;
  standing: string;
  value: number;
  max: number;
}

export interface CharacterInfo {
  name: string;
  // Forever only.
  surname: string | null;
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
  gender: string | null;
  title: string | null;
  achievementPoints: number | null;
  // null when the realm's API has no professions endpoint (e.g. Classic Era).
  professions: Professions | null;
  reputations: Reputation[];
  pvp: { rank: number; honorableKills: number } | null;
  // Forever only: Legacy challenges completed (account-wide) out of those that exist.
  legacy: { earned: number; total: number } | null;
  // Forever only: completed level-60 / 300-skill / PvP-rank achievements (account-wide), for
  // backfilling guild firsts. [] elsewhere or when the lookup fails.
  milestoneAchievements: AchievementMilestone[];
  gear: GearItem[];
}

export interface RosterEntry {
  name: string;
  // Forever only: the surname, and the name-surname slug the Profile API addresses the character by.
  surname: string | null;
  slug: string | null;
  level: number;
  classId: string | null;
  rank: number;
}

// --- Raw Blizzard shapes (only the fields we read) ---
interface RawRoster {
  members: { character: { name: string; surname?: string; slug?: string; level: number; playable_class: { id: number } }; rank: number }[];
}
interface RawSummary {
  name: string;
  surname?: string;
  faction?: { type?: string };
  level: number;
  character_class?: { id: number };
  race?: { name?: string };
  guild?: { name?: string };
  equipped_item_level?: number;
  last_login_timestamp?: number;
  gender?: { name?: string };
  active_title?: { name?: string };
  achievement_points?: number;
}
interface RawReputations {
  reputations?: { faction: { name: string }; standing: { name: string; value: number; max: number } }[];
}
interface RawPvpSummary {
  pvp_rank?: number;
  honorable_kills?: number;
}
interface RawAchievements {
  achievements?: { id: number; completed_timestamp?: number }[];
}
interface RawCategoryIndex {
  categories?: { id: number }[];
}
interface RawCategory {
  achievements?: { id: number }[];
}
interface RawAchievement {
  id: number;
  name?: string;
  reward_description?: string;
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
type RawProfession = {
  profession: { name: string };
  tiers?: { skill_points?: number; max_skill_points?: number; known_recipes?: { id: number }[] }[];
};
export interface RawProfessions {
  primaries?: RawProfession[];
  secondaries?: RawProfession[];
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
  const skills: Professions["skills"] = {};
  const recipes: number[] = [];
  const pick = (list: RawProfession[] | undefined, kind: "primary" | "secondary") =>
    (list ?? []).flatMap((p) => {
      const id = PROFESSIONS.find((x) => x.kind === kind && x.name.toLowerCase() === p.profession.name.toLowerCase())?.id;
      if (!id) return [];
      // Classic-style professions have a single tier.
      const tier = p.tiers?.[0];
      if (tier?.skill_points !== undefined) skills[id] = { skill: tier.skill_points, max: tier.max_skill_points ?? tier.skill_points };
      for (const r of tier?.known_recipes ?? []) recipes.push(r.id);
      return [id];
    });
  return {
    primary: pick(raw.primaries, "primary").slice(0, 2),
    secondary: pick(raw.secondaries, "secondary"),
    skills,
    recipes,
  };
}

export function mapReputations(raw: RawReputations | null): Reputation[] {
  return (raw?.reputations ?? []).map((r) => ({
    faction: r.faction.name,
    standing: r.standing.name,
    value: r.standing.value,
    max: r.standing.max,
  }));
}

export interface LegacyDefs {
  ids: number[];
  total: number;
  // Legacy achievements that mark a guild-firsts milestone, by achievement id.
  milestones: Record<number, MilestoneDef>;
}

export function legacyProgress(defs: LegacyDefs, raw: RawAchievements): { earned: number; total: number } {
  const legacy = new Set(defs.ids);
  const earned = (raw.achievements ?? []).filter((a) => a.completed_timestamp && legacy.has(a.id)).length;
  return { earned, total: defs.total };
}

// "Artisan <Profession>" uses the crafter noun, not the profession name.
const ARTISAN: Record<string, string> = {
  Alchemist: "alchemy",
  Blacksmith: "blacksmithing",
  Enchanter: "enchanting",
  Engineer: "engineering",
  Leatherworker: "leatherworking",
  Tailor: "tailoring",
};

// The milestone a Legacy achievement proves: "Master <Class>" (level 60 on that class),
// "Artisan <Profession>" (300 skill) or "Rank <N>" (PvP rank N). null for anything else.
export function milestoneOf(name: string): MilestoneDef | null {
  const master = /^Master (\w+)$/.exec(name);
  if (master) {
    const cls = CLASSES.find((c) => c.name === master[1]);
    return cls ? { kind: "level", key: "60", classId: cls.id } : null;
  }
  const artisan = /^Artisan (\w+)$/.exec(name);
  if (artisan && ARTISAN[artisan[1]]) return { kind: "skill", key: ARTISAN[artisan[1]], classId: null };
  const rank = /^Rank (\d+)$/.exec(name);
  const n = rank ? Number(rank[1]) : 0;
  return n >= 1 && n <= 14 ? { kind: "pvp_rank", key: String(n), classId: null } : null;
}

export function achievedMilestones(defs: LegacyDefs, raw: RawAchievements): AchievementMilestone[] {
  return (raw.achievements ?? []).flatMap((a) => {
    const def = defs.milestones[a.id];
    return def && a.completed_timestamp ? [{ ...def, completedAt: new Date(a.completed_timestamp).toISOString() }] : [];
  });
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

interface CachedCharacter {
  info: CharacterInfo | null;
  lastModified: string | null;
}

export class ArmoryService {
  private keyPrefix: string;
  // Loads in progress by cache key, so concurrent misses share one Blizzard fetch.
  private inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private client: BlizzardClient,
    private cache: ArmoryCache,
    private cfg: Pick<BlizzardConfig, "region" | "namespace" | "realm" | "guild"> & Partial<Pick<BlizzardConfig, "ranks">>,
    private now: () => number = Date.now,
  ) {
    this.keyPrefix = `${cfg.region}:${cfg.namespace}`;
  }

  get settings() {
    return this.cfg;
  }

  // Every guild member, sorted by name. Keyed by realm and guild, so a new guild never sees old data.
  roster(): Promise<RosterEntry[]> {
    const { realm, guild } = this.cfg;
    const path = realm ? `/data/wow/guild/${realm}/${guild}/roster` : `/data/wow/guild/${guild}/roster`;
    // Bump the version whenever RosterEntry changes shape: the cache outlives deploys.
    return this.cached(`${this.keyPrefix}:roster:v3:${realm ?? ""}/${guild}`, ROSTER_TTL_MS, async () => {
      const raw = await this.client.profile<RawRoster>(path);
      if (!raw) throw new BlizzardError("guild not found");
      return raw.members
        .map(({ character: c, rank }) => ({
          name: c.name,
          surname: c.surname ?? null,
          slug: c.slug ?? null,
          level: c.level,
          classId: CLASS_BY_BLIZZARD_ID[c.playable_class.id] ?? null,
          rank,
        }))
        .sort((x, y) => x.name.localeCompare(y.name));
    });
  }

  // Profile API path for a character, or null when Forever's guild roster doesn't know the name.
  // Forever has no realms: characters are addressed by a name-surname slug only the roster gives us,
  // so lookups are limited to guild members.
  private async characterPath(lower: string): Promise<string | null> {
    if (this.cfg.realm) return `/profile/wow/character/${this.cfg.realm}/${encodeURIComponent(lower)}`;
    const slug = (await this.roster()).find((r) => r.name.toLowerCase() === lower)?.slug;
    return slug ? `/profile/wow/character/${encodeURIComponent(slug)}` : null;
  }

  // `name` must already be validated as letters only.
  //
  // A character's armory data only changes when they play: every character endpoint shares the
  // last-login time as Last-Modified. So after CHARACTER_FRESH_MS, one conditional summary request
  // decides: 304 keeps the cached entry (1 call instead of 5), 200 means they played and the
  // rest is refetched. If Blizzard is down, the cached entry is served.
  async character(name: string): Promise<CharacterInfo | null> {
    const base = await this.characterPath(name.toLowerCase());
    if (!base) return null;
    // Keyed by API path (realm or slug included). v4: path-based keys with Last-Modified; v5 added metadata; v6 added recipes; v7 added milestone achievements.
    const key = `${this.keyPrefix}:character:v7:${base}`;
    const hit = this.cache.get(key) as { value: CachedCharacter; fetchedAt: number } | undefined;
    if (hit && this.now() - hit.fetchedAt < CHARACTER_FRESH_MS) return hit.value.info;

    try {
      const res = await this.client.profileIfModified<RawSummary>(base, hit?.value.lastModified ?? null);
      if (!res.modified && hit) {
        const entry = { ...hit.value, info: await this.fillMissingIcons(hit.value.info) };
        this.cache.set(key, entry, this.now());
        return entry.info;
      }
      const summary = res.modified ? res.body : null;
      const entry: CachedCharacter = summary
        ? { info: await this.loadCharacter(base, summary), lastModified: res.modified ? res.lastModified : null }
        : { info: null, lastModified: null };
      this.cache.set(key, entry, this.now());
      return entry.info;
    } catch (err) {
      if (hit && err instanceof BlizzardError) return hit.value.info;
      throw err;
    }
  }

  // Everything beyond the summary, in one parallel round: up to eight profile calls plus one icon
  // search for uncached items. They share the summary's Last-Modified, so an unchanged character
  // skips the whole round (see character()).
  private async loadCharacter(base: string, summary: RawSummary): Promise<CharacterInfo> {
    const forever = this.cfg.namespace === "forever";
    const [equipment, specs, media, professions, statistics, reputations, pvp, achievements, legacyDefs] = await Promise.all([
      this.client.profile<RawEquipment>(`${base}/equipment`),
      this.client.profile<RawSpecializations>(`${base}/specializations`),
      this.client.profile<RawMedia>(`${base}/character-media`),
      // Classic Era has no professions endpoint (always 404), so don't spend a call on it.
      this.cfg.namespace === "classic1x" ? null : this.client.profile<RawProfessions>(`${base}/professions`),
      this.client.profile<RawStatistics>(`${base}/statistics`),
      this.client.profile<RawReputations>(`${base}/reputations`),
      this.client.profile<RawPvpSummary>(`${base}/pvp-summary`),
      // Legacy challenges are achievements, and exist only on Forever.
      forever ? this.client.profile<RawAchievements>(`${base}/achievements`) : null,
      forever ? this.legacyAchievements().catch(() => null) : null,
    ]);
    const classId = summary.character_class ? (CLASS_BY_BLIZZARD_ID[summary.character_class.id] ?? null) : null;
    const items = equipment?.equipped_items ?? [];
    const icons = await this.itemIcons(items.map((i) => i.item.id));
    return {
      name: summary.name,
      surname: summary.surname ?? null,
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
      gender: summary.gender?.name ?? null,
      title: summary.active_title?.name ?? null,
      achievementPoints: summary.achievement_points ?? null,
      professions: mapProfessions(professions),
      reputations: mapReputations(reputations),
      pvp: pvp ? { rank: pvp.pvp_rank ?? 0, honorableKills: pvp.honorable_kills ?? 0 } : null,
      legacy: legacyDefs && achievements ? legacyProgress(legacyDefs, achievements) : null,
      milestoneAchievements: legacyDefs && achievements ? achievedMilestones(legacyDefs, achievements) : [],
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
  }

  // Legacy challenges are the achievements whose reward is a Legacy Point. Rather than hard-code ids
  // (Blizzard lists a copy per faction), every achievement category is read once a week and the
  // definitions are filtered by reward text. Static data, fetched in parallel.
  legacyAchievements(): Promise<LegacyDefs> {
    return this.cached(`${this.keyPrefix}:legacy:v2`, LEGACY_TTL_MS, async () => {
      const index = await this.client.gameData<RawCategoryIndex>("/data/wow/achievement-category/index");
      const categories = await mapLimit(index?.categories ?? [], STATIC_CONCURRENCY, (c) =>
        this.client.gameData<RawCategory>(`/data/wow/achievement-category/${c.id}`),
      );
      const ids = [...new Set(categories.flatMap((c) => (c?.achievements ?? []).map((a) => a.id)))];
      const defs = await mapLimit(ids, STATIC_CONCURRENCY, (id) => this.client.gameData<RawAchievement>(`/data/wow/achievement/${id}`));
      const legacy = defs.filter((d): d is RawAchievement => !!d && LEGACY_REWARD.test(d.reward_description ?? ""));
      const milestones = Object.fromEntries(
        legacy.flatMap((d) => {
          const m = milestoneOf(d.name ?? "");
          return m ? [[d.id, m]] : [];
        }),
      );
      // Faction copies share a name, so distinct names count the challenges a character can earn.
      return { ids: legacy.map((d) => d.id), total: new Set(legacy.map((d) => d.name)).size, milestones };
    });
  }

  // An unchanged character can stay cached indefinitely, so retry icons that an earlier failed
  // search left blank. Icons already cached (including "has none") cost no calls.
  private async fillMissingIcons(info: CharacterInfo | null): Promise<CharacterInfo | null> {
    const blank = info?.gear.filter((g) => g.icon === null) ?? [];
    if (!info || blank.length === 0) return info;
    const icons = await this.itemIcons(blank.map((g) => g.itemId));
    return { ...info, gear: info.gear.map((g) => (g.icon === null ? { ...g, icon: icons.get(g.itemId) ?? null } : g)) };
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
    let pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load()
        .then((value) => {
          this.cache.set(key, value, this.now());
          return value;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    try {
      return await pending;
    } catch (err) {
      if (hit && err instanceof BlizzardError) return hit.value as T;
      throw err;
    }
  }
}

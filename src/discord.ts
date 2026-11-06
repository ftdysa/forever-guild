import type { FastifyBaseLogger } from "fastify";
import type { FetchFn } from "./blizzard.js";
import type { DiscordConfig } from "./config.js";
import type { Member } from "./db.js";
import { findClass, findSpec, LEVELING_PREFS, PROFESSIONS } from "./game-data.js";

export interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface Embed {
  title: string;
  url?: string;
  description?: string;
  color: number;
  fields: EmbedField[];
  timestamp: string;
}

// Priest white is invisible on Discord's light theme.
const COLOR_OVERRIDES: Record<string, string> = { "#FFFFFF": "#C0C0C0" };
const TIMEOUT_MS = 5000;

const nameOf = (list: { id: string; name: string }[], id: string) => list.find((x) => x.id === id)?.name ?? id;

function classSpec(classId: string, specId: string | null): string {
  const cls = findClass(classId)?.name ?? classId;
  return specId ? `${cls} — ${findSpec(classId, specId)?.name ?? specId}` : cls;
}

function classColor(classId: string): number {
  const hex = findClass(classId)?.color ?? "#C0C0C0";
  return parseInt((COLOR_OVERRIDES[hex] ?? hex).slice(1), 16);
}

export function buildJoinEmbed(m: Member, siteUrl?: string): Embed {
  const fields: EmbedField[] = [
    { name: "Main", value: classSpec(m.mainClass, m.mainSpec), inline: true },
    { name: "Level", value: String(m.level), inline: true },
  ];
  if (m.backupClass && m.backupSpec) {
    fields.push({ name: "Backup", value: classSpec(m.backupClass, m.backupSpec), inline: true });
  }
  const profs = [...m.primaryProfessions, ...m.secondaryProfessions].map((id) => nameOf(PROFESSIONS, id));
  if (profs.length > 0) fields.push({ name: "Professions", value: profs.join(", "), inline: false });
  const style = [
    m.levelingPref && nameOf(LEVELING_PREFS, m.levelingPref),
  ].filter((s): s is string => !!s);
  if (style.length > 0) fields.push({ name: "Style", value: style.join(" · "), inline: false });

  return {
    title: `${[m.characterName, m.surname].filter(Boolean).join(" ")} joined the guild`,
    ...(siteUrl ? { url: siteUrl } : {}),
    color: classColor(m.mainClass),
    fields,
    timestamp: m.createdAt,
  };
}

export interface FirstsWho {
  name: string;
  surname: string | null;
  classId: string;
}

export function buildFirstsEmbed(who: FirstsWho, claims: string[], at: string, siteUrl?: string): Embed {
  const name = [who.name, who.surname].filter(Boolean).join(" ");
  return {
    title: claims.length === 1 ? `${name} claimed a guild first` : `${name} claimed ${claims.length} guild firsts`,
    ...(siteUrl ? { url: `${siteUrl.replace(/\/+$/, "")}/#progress` } : {}),
    description: claims.map((c) => `🏆 ${c}`).join("\n"),
    color: classColor(who.classId),
    fields: [],
    timestamp: at,
  };
}

export class DiscordNotifier {
  constructor(
    private config: DiscordConfig,
    private log: FastifyBaseLogger,
    private fetchFn: FetchFn = fetch,
  ) {}

  memberJoined(m: Member): Promise<void> {
    return this.send(() => buildJoinEmbed(m, this.config.siteUrl));
  }

  guildFirsts(who: FirstsWho, claims: string[], at: string): Promise<void> {
    return this.send(() => buildFirstsEmbed(who, claims, at, this.config.siteUrl));
  }

  // Never throws: a lost announcement must not affect the API response. Logs never include the URL.
  private async send(build: () => Embed): Promise<void> {
    try {
      const embed = build();
      const res = await this.fetchFn(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.log.warn({ status: res.status }, "discord webhook rejected");
        await res.body?.cancel();
      }
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, "discord webhook failed");
    }
  }
}

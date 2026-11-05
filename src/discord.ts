import type { FastifyBaseLogger } from "fastify";
import type { FetchFn } from "./blizzard.js";
import type { DiscordConfig } from "./config.js";
import type { Member } from "./db.js";
import { findClass, findSpec, LEVELING_PREFS, PROFESSIONS, SWEAT_FACTORS } from "./game-data.js";

export interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface Embed {
  title: string;
  url?: string;
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
    m.sweatFactor && nameOf(SWEAT_FACTORS, m.sweatFactor),
    m.levelingPref && nameOf(LEVELING_PREFS, m.levelingPref),
  ].filter((s): s is string => !!s);
  if (style.length > 0) fields.push({ name: "Style", value: style.join(" · "), inline: false });

  const hex = findClass(m.mainClass)?.color ?? "#C0C0C0";
  return {
    title: `${[m.characterName, m.surname].filter(Boolean).join(" ")} joined the guild`,
    ...(siteUrl ? { url: siteUrl } : {}),
    color: parseInt((COLOR_OVERRIDES[hex] ?? hex).slice(1), 16),
    fields,
    timestamp: m.createdAt,
  };
}

export class DiscordNotifier {
  constructor(
    private config: DiscordConfig,
    private log: FastifyBaseLogger,
    private fetchFn: FetchFn = fetch,
  ) {}

  // Never throws: a lost announcement must not affect the API response. Logs never include the URL.
  async memberJoined(m: Member): Promise<void> {
    try {
      const res = await this.fetchFn(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds: [buildJoinEmbed(m, this.config.siteUrl)], allowed_mentions: { parse: [] } }),
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

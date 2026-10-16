export interface Config {
  port: number;
  dbPath: string;
  guildPassphrase: string;
  sessionSecret: string;
  cookieSecure: boolean;
  // Trust exactly one reverse proxy hop when resolving req.ip.
  trustProxy?: boolean;
  // Header set by the edge proxy carrying the real client IP (e.g. fly-client-ip). Only set
  // this when every request is guaranteed to pass through that proxy, or clients can spoof it.
  clientIpHeader?: string;
  // Blizzard armory integration; undefined when not configured.
  blizzard?: BlizzardConfig;
}

export interface BlizzardConfig {
  clientId: string;
  clientSecret: string;
  region: string;
  // classic1x = Classic Era / Anniversary, classic = progression Classic, retail = live game.
  namespace: string;
  realm: string;
  guild: string;
}

const BLIZZARD_REGIONS = ["us", "eu", "kr", "tw"];
const BLIZZARD_NAMESPACES = ["classic1x", "classic", "retail"];
const SLUG_RE = /^[a-z0-9-]+$/;

function loadBlizzardConfig(env: NodeJS.ProcessEnv): BlizzardConfig | undefined {
  const keys = ["BLIZZARD_CLIENT_ID", "BLIZZARD_CLIENT_SECRET", "BLIZZARD_REALM", "BLIZZARD_GUILD"];
  const set = keys.filter((k) => env[k]);
  if (set.length === 0) return undefined;
  if (set.length < keys.length) {
    throw new Error(`Blizzard armory is partly configured; also set: ${keys.filter((k) => !env[k]).join(", ")}`);
  }
  const region = env.BLIZZARD_REGION || "us";
  if (!BLIZZARD_REGIONS.includes(region)) throw new Error(`BLIZZARD_REGION must be one of ${BLIZZARD_REGIONS.join(", ")}`);
  const namespace = env.BLIZZARD_NAMESPACE || "classic1x";
  if (!BLIZZARD_NAMESPACES.includes(namespace)) {
    throw new Error(`BLIZZARD_NAMESPACE must be one of ${BLIZZARD_NAMESPACES.join(", ")}`);
  }
  const realm = env.BLIZZARD_REALM as string;
  const guild = env.BLIZZARD_GUILD as string;
  if (!SLUG_RE.test(realm) || !SLUG_RE.test(guild)) {
    throw new Error("BLIZZARD_REALM and BLIZZARD_GUILD must be slugs (lowercase letters, digits, hyphens)");
  }
  return {
    clientId: env.BLIZZARD_CLIENT_ID as string,
    clientSecret: env.BLIZZARD_CLIENT_SECRET as string,
    region,
    namespace,
    realm,
    guild,
  };
}

const MIN_PASSPHRASE_LENGTH = 16;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["GUILD_PASSPHRASE", "SESSION_SECRET"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  const guildPassphrase = env.GUILD_PASSPHRASE as string;
  if (guildPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`GUILD_PASSPHRASE must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const sessionSecret = env.SESSION_SECRET as string;
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  const portRaw = env.PORT ?? "3000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a number");
  }
  return {
    port,
    dbPath: env.DB_PATH || "./data/roster.db",
    guildPassphrase,
    sessionSecret,
    cookieSecure: env.COOKIE_SECURE === "true",
    trustProxy: env.TRUST_PROXY === "true",
    clientIpHeader: env.CLIENT_IP_HEADER?.toLowerCase() || undefined,
    blizzard: loadBlizzardConfig(env),
  };
}

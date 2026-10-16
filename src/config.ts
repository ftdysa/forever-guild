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
  };
}

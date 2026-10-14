export interface Config {
  port: number;
  dbPath: string;
  guildPassphrase: string;
  sessionSecret: string;
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["GUILD_PASSPHRASE", "SESSION_SECRET"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
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
    guildPassphrase: env.GUILD_PASSPHRASE as string,
    sessionSecret,
    cookieSecure: env.COOKIE_SECURE === "true",
  };
}

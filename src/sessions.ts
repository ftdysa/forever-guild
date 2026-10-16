import type Database from "better-sqlite3";
import { createHash, createHmac, randomBytes } from "node:crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions (created_at);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Sessions live server-side so logout and passphrase changes actually revoke them.
// Only token hashes are stored, so a leaked database does not yield usable cookies.
export class SessionStore {
  private insert: Database.Statement;
  private find: Database.Statement;
  private remove: Database.Statement;
  private purgeExpired: Database.Statement;

  constructor(db: Database.Database, passphrase: string, secret: string) {
    db.exec(SCHEMA);
    this.insert = db.prepare("INSERT INTO sessions (token_hash, created_at) VALUES (?, ?)");
    this.find = db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND created_at > ?");
    this.remove = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
    this.purgeExpired = db.prepare("DELETE FROM sessions WHERE created_at <= ?");
    revokeAllIfPassphraseChanged(db, createHmac("sha256", secret).update(passphrase).digest("hex"));
  }

  create(): string {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    this.purgeExpired.run(now - SESSION_TTL_MS);
    this.insert.run(hashToken(token), now);
    return token;
  }

  isValid(token: string): boolean {
    return this.find.get(hashToken(token), Date.now() - SESSION_TTL_MS) !== undefined;
  }

  revoke(token: string): void {
    this.remove.run(hashToken(token));
  }
}

function revokeAllIfPassphraseChanged(db: Database.Database, fingerprint: string): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'passphrase'").get() as { value: string } | undefined;
  if (row?.value === fingerprint) return;
  db.transaction(() => {
    db.prepare("DELETE FROM sessions").run();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('passphrase', ?)").run(fingerprint);
  })();
}

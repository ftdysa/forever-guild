import { ArmoryCache, MemberStore, openDatabase, wipeGuildData } from "./db.js";

// Wipes all members and cached armory data. Usage: node dist/reset-data.js --yes
const dbPath = process.env.DB_PATH || "./data/roster.db";
if (!process.argv.includes("--yes")) {
  console.error(`This permanently deletes every member and all cached armory data in ${dbPath}.`);
  console.error("Re-run with --yes to confirm.");
  process.exit(1);
}

const db = openDatabase(dbPath);
// Ensure the tables exist so a fresh database wipes cleanly.
new MemberStore(db);
new ArmoryCache(db);
const { members, cached } = wipeGuildData(db);
db.close();
console.log(`Removed ${members} members and ${cached} cached armory entries from ${dbPath}.`);

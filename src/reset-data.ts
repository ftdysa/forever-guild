import { ArmoryCache, MemberStore, openDatabase, wipeGuildData } from "./db.js";
import { ProgressStore } from "./progress-store.js";

// Wipes all members, cached armory data and progress history. Usage: node dist/reset-data.js --yes
const dbPath = process.env.DB_PATH || "./data/roster.db";
if (!process.argv.includes("--yes")) {
  console.error(`This permanently deletes every member, all cached armory data and all progress history in ${dbPath}.`);
  console.error("Re-run with --yes to confirm.");
  process.exit(1);
}

const db = openDatabase(dbPath);
// Ensure the tables exist so a fresh database wipes cleanly.
new MemberStore(db);
new ArmoryCache(db);
const { members, cached } = wipeGuildData(db);
const { snapshots, milestones } = new ProgressStore(db).wipe();
db.close();
console.log(`Removed ${members} members, ${cached} cached armory entries, ${snapshots} snapshots and ${milestones} milestones from ${dbPath}.`);

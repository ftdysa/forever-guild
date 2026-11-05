import { BlizzardClient } from "./blizzard.js";
import { loadConfig } from "./config.js";
import { ArmoryCache, openDatabase } from "./db.js";
import { RecipeCatalog } from "./recipe-catalog.js";

// Rebuilds the Forever recipe catalog now, e.g. if recipes changed without a new game build.
// The running server picks up the new catalog on its next request. Usage: node dist/refresh-recipes.js
const config = loadConfig();
const bz = config.blizzard;
if (!bz || bz.namespace !== "forever") {
  console.error("The recipe catalog needs BLIZZARD_* configured with BLIZZARD_NAMESPACE=forever.");
  process.exit(1);
}
const db = openDatabase(config.dbPath);
const catalog = new RecipeCatalog(new BlizzardClient(bz), new ArmoryCache(db), bz.region);
try {
  const c = await catalog.rebuild();
  const recipes = c.professions.reduce((n, p) => n + p.total, 0);
  console.log(`Built recipe catalog for build ${c.build}: ${recipes} recipes in ${c.professions.length} professions.`);
} catch (err) {
  console.error(`Recipe catalog build failed: ${(err as Error).message}. The previous catalog is unchanged.`);
  process.exitCode = 1;
} finally {
  db.close();
}

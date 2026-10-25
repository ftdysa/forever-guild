import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSES } from "../src/game-data.js";
import { classOverview } from "../public/class-overview.js";

const m = (characterName: string, mainClass: string, mainSpec: string, backupClass: string | null = null, backupSpec: string | null = null) => ({
  characterName, mainClass, mainSpec, backupClass, backupSpec,
});

test("lists every class and spec in order, empty when no members", () => {
  const out = classOverview([], CLASSES);
  assert.deepEqual(out.map((c) => c.cls.id), CLASSES.map((c) => c.id));
  for (const c of out) {
    assert.equal(c.mainCount, 0);
    assert.equal(c.backupCount, 0);
    assert.deepEqual(c.specs.map((s) => s.spec.id), c.cls.specs.map((s) => s.id));
    for (const s of c.specs) {
      assert.deepEqual(s.mains, []);
      assert.deepEqual(s.backups, []);
    }
  }
});

test("groups mains and backups by class and spec, keeping member order", () => {
  const members = [
    m("Mildred", "paladin", "holy"),
    m("Grumpus", "warrior", "arms", "paladin", "holy"),
    m("Gerald", "paladin", "holy"),
    m("Pops", "priest", "shadow", "warrior", "protection"),
  ];
  const out = classOverview(members, CLASSES);
  const paladin = out.find((c) => c.cls.id === "paladin")!;
  assert.equal(paladin.mainCount, 2);
  assert.equal(paladin.backupCount, 1);
  const holy = paladin.specs.find((s) => s.spec.id === "holy")!;
  assert.deepEqual(holy.mains, ["Mildred", "Gerald"]);
  assert.deepEqual(holy.backups, ["Grumpus"]);

  const warrior = out.find((c) => c.cls.id === "warrior")!;
  assert.equal(warrior.mainCount, 1);
  assert.equal(warrior.backupCount, 1);
  assert.deepEqual(warrior.specs.find((s) => s.spec.id === "protection")!.backups, ["Pops"]);
});

test("ignores unknown class/spec pairs", () => {
  const out = classOverview([m("Ghost", "deathknight", "blood"), m("Odd", "mage", "nope")], CLASSES);
  assert.equal(out.reduce((n, c) => n + c.mainCount + c.backupCount, 0), 0);
});

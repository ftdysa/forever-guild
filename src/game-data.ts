export type Role = "tank" | "healer" | "dps";

export interface Spec {
  id: string;
  name: string;
  role: Role;
}

export interface GameClass {
  id: string;
  name: string;
  color: string;
  specs: Spec[];
}

export interface Profession {
  id: string;
  name: string;
  kind: "primary" | "secondary";
}

export interface Choice {
  id: string;
  name: string;
}

const spec = (id: string, name: string, role: Role): Spec => ({ id, name, role });

export const CLASSES: GameClass[] = [
  {
    id: "warrior",
    name: "Warrior",
    color: "#C69B6D",
    specs: [spec("arms", "Arms", "dps"), spec("fury", "Fury", "dps"), spec("protection", "Protection", "tank")],
  },
  {
    id: "paladin",
    name: "Paladin",
    color: "#F48CBA",
    specs: [spec("holy", "Holy", "healer"), spec("protection", "Protection", "tank"), spec("retribution", "Retribution", "dps")],
  },
  {
    id: "hunter",
    name: "Hunter",
    color: "#AAD372",
    specs: [spec("beast-mastery", "Beast Mastery", "dps"), spec("marksmanship", "Marksmanship", "dps"), spec("survival", "Survival", "dps")],
  },
  {
    id: "rogue",
    name: "Rogue",
    color: "#FFF468",
    specs: [spec("assassination", "Assassination", "dps"), spec("combat", "Combat", "dps"), spec("subtlety", "Subtlety", "dps")],
  },
  {
    id: "priest",
    name: "Priest",
    color: "#FFFFFF",
    specs: [spec("discipline", "Discipline", "healer"), spec("holy", "Holy", "healer"), spec("shadow", "Shadow", "dps")],
  },
  {
    id: "shaman",
    name: "Shaman",
    color: "#0070DD",
    specs: [spec("elemental", "Elemental", "dps"), spec("enhancement", "Enhancement", "dps"), spec("restoration", "Restoration", "healer")],
  },
  {
    id: "mage",
    name: "Mage",
    color: "#3FC7EB",
    specs: [spec("arcane", "Arcane", "dps"), spec("fire", "Fire", "dps"), spec("frost", "Frost", "dps")],
  },
  {
    id: "warlock",
    name: "Warlock",
    color: "#8788EE",
    specs: [spec("affliction", "Affliction", "dps"), spec("demonology", "Demonology", "dps"), spec("destruction", "Destruction", "dps")],
  },
  {
    id: "druid",
    name: "Druid",
    color: "#FF7C0A",
    specs: [spec("balance", "Balance", "dps"), spec("feral-combat", "Feral Combat", "tank"), spec("restoration", "Restoration", "healer")],
  },
];

export const PROFESSIONS: Profession[] = [
  { id: "alchemy", name: "Alchemy", kind: "primary" },
  { id: "blacksmithing", name: "Blacksmithing", kind: "primary" },
  { id: "enchanting", name: "Enchanting", kind: "primary" },
  { id: "engineering", name: "Engineering", kind: "primary" },
  { id: "herbalism", name: "Herbalism", kind: "primary" },
  { id: "leatherworking", name: "Leatherworking", kind: "primary" },
  { id: "mining", name: "Mining", kind: "primary" },
  { id: "skinning", name: "Skinning", kind: "primary" },
  { id: "tailoring", name: "Tailoring", kind: "primary" },
  { id: "cooking", name: "Cooking", kind: "secondary" },
  { id: "fishing", name: "Fishing", kind: "secondary" },
  { id: "first-aid", name: "First Aid", kind: "secondary" },
];

export const SWEAT_FACTORS: Choice[] = [
  { id: "meh", name: "Meh" },
  { id: "casual", name: "Casual" },
  { id: "interested", name: "Interested" },
  { id: "sweaty", name: "Sweaty" },
  { id: "world-first", name: "World First" },
];

export const LEVELING_PREFS: Choice[] = [
  { id: "solo", name: "Solo" },
  { id: "duo", name: "Duo" },
  { id: "orgy", name: "Orgy" },
];

export const PRIMARY_IDS: string[] = PROFESSIONS.filter((p) => p.kind === "primary").map((p) => p.id);
export const SECONDARY_IDS: string[] = PROFESSIONS.filter((p) => p.kind === "secondary").map((p) => p.id);

export function findClass(id: string): GameClass | undefined {
  return CLASSES.find((c) => c.id === id);
}

export function findSpec(classId: string, specId: string): Spec | undefined {
  return findClass(classId)?.specs.find((s) => s.id === specId);
}

export function gameData(): {
  classes: GameClass[];
  professions: Profession[];
  sweatFactors: Choice[];
  levelingPrefs: Choice[];
} {
  return { classes: CLASSES, professions: PROFESSIONS, sweatFactors: SWEAT_FACTORS, levelingPrefs: LEVELING_PREFS };
}

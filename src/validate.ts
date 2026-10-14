import { findClass, findSpec, PRIMARY_IDS, SECONDARY_IDS } from "./game-data.js";

export interface MemberInput {
  characterName: string;
  mainClass: string;
  mainSpec: string;
  backupClass: string | null;
  backupSpec: string | null;
  primaryProfessions: string[];
  secondaryProfessions: string[];
  notes: string;
}

export type ValidationResult = { ok: true; value: MemberInput } | { ok: false; errors: string[] };

const NAME_RE = /^\p{L}{2,24}$/u;
const NOTES_MAX = 280;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function distinct(arr: string[]): boolean {
  return new Set(arr).size === arr.length;
}

export function validateMember(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  const characterName = typeof raw.characterName === "string" ? raw.characterName.trim() : "";
  if (!NAME_RE.test(characterName)) errors.push("characterName must be 2-24 letters");

  const mainClass = typeof raw.mainClass === "string" ? raw.mainClass : "";
  const mainSpec = typeof raw.mainSpec === "string" ? raw.mainSpec : "";
  if (!findClass(mainClass)) errors.push("mainClass is not a known class");
  else if (!findSpec(mainClass, mainSpec)) errors.push("mainSpec does not belong to mainClass");

  let backupClass: string | null = typeof raw.backupClass === "string" && raw.backupClass !== "" ? raw.backupClass : null;
  let backupSpec: string | null = typeof raw.backupSpec === "string" && raw.backupSpec !== "" ? raw.backupSpec : null;
  if (backupClass === null) {
    backupSpec = null;
  } else if (!findClass(backupClass)) {
    errors.push("backupClass is not a known class");
  } else if (backupSpec === null) {
    errors.push("backupSpec is required when backupClass is set");
  } else if (!findSpec(backupClass, backupSpec)) {
    errors.push("backupSpec does not belong to backupClass");
  } else if (backupClass === mainClass && backupSpec === mainSpec) {
    errors.push("backup cannot be the same class and spec as main");
  }

  const primaryProfessions = isStringArray(raw.primaryProfessions) ? raw.primaryProfessions : null;
  if (
    !primaryProfessions ||
    primaryProfessions.length !== 2 ||
    !distinct(primaryProfessions) ||
    !primaryProfessions.every((p) => PRIMARY_IDS.includes(p))
  ) {
    errors.push("primaryProfessions must be exactly 2 distinct primary professions");
  }

  const secondaryRaw = raw.secondaryProfessions === undefined ? [] : raw.secondaryProfessions;
  const secondaryProfessions = isStringArray(secondaryRaw) ? secondaryRaw : null;
  if (!secondaryProfessions || !distinct(secondaryProfessions) || !secondaryProfessions.every((p) => SECONDARY_IDS.includes(p))) {
    errors.push("secondaryProfessions must be distinct secondary professions");
  }

  let notes = "";
  if (raw.notes !== undefined && raw.notes !== null) {
    if (typeof raw.notes !== "string") errors.push("notes must be at most 280 characters");
    else {
      notes = raw.notes.trim();
      if (notes.length > NOTES_MAX) errors.push("notes must be at most 280 characters");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      characterName,
      mainClass,
      mainSpec,
      backupClass,
      backupSpec,
      primaryProfessions: primaryProfessions as string[],
      secondaryProfessions: secondaryProfessions as string[],
      notes,
    },
  };
}

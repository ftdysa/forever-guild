import { findClass, findSpec, LEVELING_PREFS, SWEAT_FACTORS, type Choice } from "./game-data.js";

// The fields people edit; everything else on a member comes from the guild roster and armory.
export interface MemberDetails {
  mainSpec: string | null;
  backupClass: string | null;
  backupSpec: string | null;
  sweatFactor: string | null;
  levelingPref: string | null;
  notes: string;
}

export type ValidationResult = { ok: true; value: MemberDetails } | { ok: false; errors: string[] };

export const NAME_RE = /^\p{L}{2,24}$/u;
const NOTES_MAX = 280;

/** Optional choice: missing/null/"" → null; otherwise must be one of `choices`. */
function optionalChoice(v: unknown, choices: Choice[]): { ok: boolean; value: string | null } {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v === "string" && choices.some((c) => c.id === v)) return { ok: true, value: v };
  return { ok: false, value: null };
}

const optionalString = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

// `mainClass` is the member's synced class; specs are checked against it.
export function validateDetails(input: unknown, mainClass: string): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  for (const k of ["mainSpec", "backupClass", "backupSpec"]) {
    if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== "string") errors.push(`${k} must be a string or null`);
  }
  const mainSpec = optionalString(raw.mainSpec);
  if (mainSpec !== null && !findSpec(mainClass, mainSpec)) errors.push("mainSpec does not belong to the main class");

  const backupClass = optionalString(raw.backupClass);
  let backupSpec = optionalString(raw.backupSpec);
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

  const sweatFactor = optionalChoice(raw.sweatFactor, SWEAT_FACTORS);
  if (!sweatFactor.ok) errors.push("sweatFactor is not a known sweat factor");
  const levelingPref = optionalChoice(raw.levelingPref, LEVELING_PREFS);
  if (!levelingPref.ok) errors.push("levelingPref is not a known leveling preference");

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
    value: { mainSpec, backupClass, backupSpec, sweatFactor: sweatFactor.value, levelingPref: levelingPref.value, notes },
  };
}

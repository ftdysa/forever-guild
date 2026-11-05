// Groups members by class and spec for the Classes tab. Pure, so it is unit tested from Node.
export function classOverview(members, classes) {
  // kind is "main" or "backup", matching the member's mainClass/mainSpec or backupClass/backupSpec.
  const names = (kind, cls, spec) =>
    members.filter((m) => m[`${kind}Class`] === cls.id && m[`${kind}Spec`] === spec.id).map((m) => m.characterName);
  return classes.map((cls) => {
    const specs = cls.specs.map((spec) => ({ spec, mains: names("main", cls, spec), backups: names("backup", cls, spec) }));
    return {
      cls,
      // By class, so members whose spec isn't known yet still count.
      mainCount: members.filter((m) => m.mainClass === cls.id).length,
      backupCount: members.filter((m) => m.backupClass === cls.id).length,
      specs,
    };
  });
}

// Most-played classes first for the bar chart; Array#sort is stable, so ties keep class order.
export function byCoverage(overview) {
  return [...overview].sort((a, b) => b.mainCount - a.mainCount || b.backupCount - a.backupCount);
}

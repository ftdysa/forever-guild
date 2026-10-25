// Groups members by class and spec for the Classes tab. Pure, so it is unit tested from Node.
export function classOverview(members, classes) {
  return classes.map((cls) => {
    const specs = cls.specs.map((spec) => ({
      spec,
      mains: members.filter((m) => m.mainClass === cls.id && m.mainSpec === spec.id).map((m) => m.characterName),
      backups: members.filter((m) => m.backupClass === cls.id && m.backupSpec === spec.id).map((m) => m.characterName),
    }));
    return {
      cls,
      mainCount: specs.reduce((n, s) => n + s.mains.length, 0),
      backupCount: specs.reduce((n, s) => n + s.backups.length, 0),
      specs,
    };
  });
}

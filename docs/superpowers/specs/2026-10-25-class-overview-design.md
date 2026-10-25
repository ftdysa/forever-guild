# Class Overview — Design

Date: 2026-10-25

## Purpose

Show at a glance which classes and specs the guild has covered, and by whom,
so gaps are obvious without scanning the roster table.

## Decisions (from brainstorming)

- Content: class → spec grid. One card per class, one row per spec, with
  member names. Mains and backups are counted and listed separately.
- Navigation: a `Roster | Classes` tab bar on the existing page, driven by
  `location.hash` (`#classes`; empty or anything else = roster).
- Computed client-side from the already-loaded `members` and game data. No
  API or server changes.

## UI

- Tab bar sits inside `#roster`, below the toolbar. The Coverage panel shows
  on both tabs; the Roster table panel shows only on the Roster tab; the new
  `#class-overview` panel shows only on the Classes tab.
- Switching tabs sets the hash; `hashchange` and boot both apply it, so
  `#classes` deep links and survives reload.
- Grid of cards in `CLASSES` order. All classes and specs are shown,
  including empty ones (empty specs dimmed).
- Card header: class name in class colour (via `paintClasses`, no inline
  styles, CSP unchanged) and `N main · M backup`.
- Spec row: role icon, spec name, main count, main member names; backups on
  a muted line, e.g. `+1 backup: Pops`.
- When the armory is enabled, member names are buttons with
  `data-action="armory"` opening the armory dialog, as on the roster.
- Responsive: cards stack to one column on narrow screens.

## Code

- `classOverview(members, classes)` — pure; returns
  `[{ cls, mainCount, backupCount, specs: [{ spec, mains, backups }] }]`
  where `mains`/`backups` are character names sorted as `members` is.
  Members whose class/spec is unknown are skipped.
- `renderClassOverview()` — renders the panel; called at the end of
  `renderRoster()` so every data change refreshes it.
- `style.css` — a small `.class-grid` / `.class-card` block reusing panel
  styles.

## Testing

The frontend has no test harness. Verify manually with `npm run dev`: add
members across classes (mains and backups), check both tabs, the `#classes`
deep link, armory links, empty states, and mobile width. `npm run lint`,
`npm run typecheck`, and `npm test` must pass.

## Out of scope

Filters, sorting, profession overview, server changes.

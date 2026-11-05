// Crafting directory: filtering is pure (unit tested from Node); rendering takes app helpers.
export const CAP = 200;

// mode: "known" (someone in the guild knows it), "gaps" (nobody does), "all".
export function filterCatalog(catalog, crafters, { query = "", profession = "", mode = "known" } = {}) {
  const q = query.trim().toLowerCase();
  const groups = [];
  let total = 0;
  let shown = 0;
  for (const p of catalog.professions) {
    if (profession && p.id !== profession) continue;
    for (const c of p.categories) {
      const rows = [];
      for (const recipe of c.recipes) {
        const who = crafters[recipe.id] ?? [];
        if (mode === "known" && who.length === 0) continue;
        if (mode === "gaps" && who.length > 0) continue;
        const reagentHits = q ? recipe.reagents.filter((r) => r.name.toLowerCase().includes(q)).map((r) => r.itemId) : [];
        const nameHit = recipe.name.toLowerCase().includes(q) || (recipe.itemName ?? "").toLowerCase().includes(q);
        if (q && !nameHit && reagentHits.length === 0) continue;
        total++;
        if (shown < CAP) {
          rows.push({ recipe, crafters: who, reagentHits });
          shown++;
        }
      }
      if (rows.length) groups.push({ profession: p, category: c.name, rows });
    }
  }
  return { groups, total, shown };
}

export function coverage(catalog, crafters) {
  return catalog.professions.map((p) => ({
    id: p.id,
    name: p.name,
    known: p.categories.reduce((n, c) => n + c.recipes.filter((r) => (crafters[r.id] ?? []).length > 0).length, 0),
    total: p.total,
  }));
}

const link = (url, text, esc) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;

// Renders the profession chips and results into the Crafting panel.
export function renderCrafting(root, data, state, { esc, characterName, itemUrl }) {
  const chips = root.querySelector("#crafting-profs");
  chips.innerHTML =
    `<button type="button" class="chip" data-profession="" aria-pressed="${state.profession === ""}">All</button>` +
    coverage(data.catalog, data.crafters)
      .map(
        (p) =>
          `<button type="button" class="chip" data-profession="${esc(p.id)}" aria-pressed="${state.profession === p.id}">${esc(p.name)} <b>${p.known}/${p.total}</b></button>`,
      )
      .join("");
  for (const b of root.querySelectorAll("#crafting-mode .chip")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));

  const { groups, total, shown } = filterCatalog(data.catalog, data.crafters, state);
  const row = ({ recipe, crafters, reagentHits }) => {
    const title = recipe.itemId ? link(itemUrl(recipe.itemId), recipe.name, esc) : esc(recipe.name);
    const makes = recipe.makes > 1 ? ` <span class="muted">×${recipe.makes}</span>` : "";
    const who = crafters.length
      ? crafters.map((c) => `${characterName(c, "member")}${c.skill != null ? ` <span class="muted">${c.skill}</span>` : ""}`).join(", ")
      : '<span class="muted">— nobody yet</span>';
    const reagents = recipe.reagents
      .map((r) => {
        const text = `${link(itemUrl(r.itemId), r.name, esc)} ×${Number(r.quantity)}`;
        return reagentHits.includes(r.itemId) ? `<mark>${text}</mark>` : text;
      })
      .join(" · ");
    return `<li class="craft-row">
      <div class="craft-name">${title}${makes}</div>
      <div class="craft-who">${who}</div>
      <div class="craft-reagents muted">${reagents}</div>
    </li>`;
  };
  const results = root.querySelector("#crafting-results");
  results.innerHTML =
    (groups.length
      ? groups
          .map((g) => `<section class="craft-group"><h3>${esc(g.profession.name)} · ${esc(g.category)}</h3><ul class="craft-list">${g.rows.map(row).join("")}</ul></section>`)
          .join("")
      : '<p class="muted">No recipes match.</p>') +
    (total > shown ? `<p class="muted">Showing ${shown} of ${total}. Refine your search to see the rest.</p>` : "");
}

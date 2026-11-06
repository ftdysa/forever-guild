// Posts the merged PR's "## Release notes" section to the guild's Discord webhook. Run by the
// deploy workflow after a successful deploy; see docs/superpowers/specs/2026-11-06-release-notes-design.md.
// Plain Node with no dependencies, so the job needs no npm install.
import { pathToFileURL } from "node:url";

const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;
const GOLD = 0xd4a017;
// A section that only says this is the same as no section.
const NOTHING = /^(none|n\/a|-)?$/i;

/**
 * The text under a `## Release notes` heading, up to the next `## ` heading, without HTML comments.
 * @param {string | null | undefined} body
 * @returns {string | null} null when there is nothing to announce
 */
export function extractReleaseNotes(body) {
  if (!body) return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s+release notes\s*$/i.test(l.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  // `## ` ends the section; `### ` does not.
  const end = rest.findIndex((l) => /^##\s/.test(l));
  const notes = (end < 0 ? rest : rest.slice(0, end))
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return NOTHING.test(notes) ? null : notes;
}

const cap = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * A Discord embed for the notes. A leading `### Heading` line becomes the title instead of the PR title.
 * @param {{ prTitle: string, notes: string, siteUrl: string | undefined, at: string }} input
 */
export function buildReleaseEmbed({ prTitle, notes, siteUrl, at }) {
  const heading = /^###\s+(.+)(\n|$)/.exec(notes);
  const title = heading ? heading[1].trim() : prTitle;
  const description = heading ? notes.slice(heading[0].length).trim() : notes;
  return {
    title: cap(title, MAX_TITLE),
    description: cap(description, MAX_DESCRIPTION),
    color: GOLD,
    ...(siteUrl ? { url: siteUrl } : {}),
    timestamp: at,
  };
}

/**
 * Finds the PR merged by GITHUB_SHA and posts its release notes. Never throws: the deploy has
 * already happened, so a lost announcement only warns. Never logs the webhook URL.
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchFn
 * @param {(line: string) => void} [log]
 * @returns {Promise<"posted" | "skipped" | "failed">}
 */
export async function announce(env, fetchFn, log = console.log) {
  const warn = (msg) => log(`::warning::release note: ${msg}`);
  try {
    if (!env.DISCORD_WEBHOOK_URL) {
      warn("DISCORD_WEBHOOK_URL is not set; skipping");
      return "skipped";
    }
    const res = await fetchFn(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/commits/${env.GITHUB_SHA}/pulls`, {
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      warn(`GitHub returned ${res.status} looking up the PR`);
      return "failed";
    }
    const pr = (await res.json()).find((p) => p.merged_at);
    const notes = extractReleaseNotes(pr?.body);
    if (!pr || !notes) {
      log(pr ? `PR #${pr.number} has no release notes; nothing to post` : "no merged PR for this commit; nothing to post");
      return "skipped";
    }
    const embed = buildReleaseEmbed({ prTitle: pr.title, notes, siteUrl: env.SITE_URL || undefined, at: new Date().toISOString() });
    const posted = await fetchFn(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!posted.ok) {
      warn(`Discord returned ${posted.status}`);
      return "failed";
    }
    log(`posted release notes for PR #${pr.number}`);
    return "posted";
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return "failed";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await announce(process.env, fetch);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { announce, buildReleaseEmbed, extractReleaseNotes } from "../scripts/release-note.mjs";

const AT = "2026-11-06T17:00:00.000Z";

test("extractReleaseNotes takes the section up to the next ## heading", () => {
  const body = "Summary\n\n## Release notes\n<!-- what players see -->\n**New:** sweat\n### not an end\nmore\n\n## Testing\nnpm test";
  assert.equal(extractReleaseNotes(body), "**New:** sweat\n### not an end\nmore");
  assert.equal(extractReleaseNotes("## release NOTES\r\nline one\r\n"), "line one");
});

test("extractReleaseNotes skips missing, empty and 'none' sections", () => {
  for (const body of [null, "", "no section here", "## Release notes\n", "## Release notes\n<!-- prompt -->\n", "## Release notes\nNone", "## Release notes\nn/a", "## Release notes\n-"]) {
    assert.equal(extractReleaseNotes(body), null, JSON.stringify(body));
  }
});

test("buildReleaseEmbed uses the PR title, or a leading ### heading", () => {
  assert.deepEqual(buildReleaseEmbed({ prTitle: "Feat/sweat factor", notes: "Body", siteUrl: undefined, at: AT }), {
    title: "Feat/sweat factor",
    description: "Body",
    color: 0xd4a017,
    timestamp: AT,
  });
  const e = buildReleaseEmbed({ prTitle: "x", notes: "### 💦 New: Sweat Factor\nBody", siteUrl: "https://example.test", at: AT });
  assert.equal(e.title, "💦 New: Sweat Factor");
  assert.equal(e.description, "Body");
  assert.equal(e.url, "https://example.test");
});

test("buildReleaseEmbed caps the title and description at Discord's limits", () => {
  const e = buildReleaseEmbed({ prTitle: "t".repeat(300), notes: "d".repeat(5000), siteUrl: undefined, at: AT });
  assert.equal(e.title.length, 256);
  assert.equal(e.description.length, 4096);
  assert.ok(e.description.endsWith("…"));
});

// A fake fetch for the GitHub API and the webhook; records every call.
function fake({ pulls = [] as unknown[], webhookStatus = 204, githubStatus = 200 } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const fetchFn = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://api.github.com/")) return Response.json(pulls, { status: githubStatus });
    return new Response(null, { status: webhookStatus });
  };
  return { fetchFn, calls, logs, log };
}

const ENV = {
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/secret-token",
  GITHUB_REPOSITORY: "ftdysa/forever-guild",
  GITHUB_SHA: "abc123",
  GITHUB_TOKEN: "gh-token",
  SITE_URL: "https://example.test",
};

const merged = (body: string | null) => ({ number: 17, title: "Feat/sweat factor", body, merged_at: "2026-11-06T16:43:09Z" });

test("announce posts the merged PR's release notes to the webhook", async () => {
  const { fetchFn, calls, logs, log } = fake({ pulls: [merged("## Release notes\nHello guild")] });
  const result = await announce(ENV, fetchFn, log);
  assert.deepEqual(logs, ["posted release notes for PR #17"]);
  assert.equal(result, "posted");
  assert.equal(calls[0].url, "https://api.github.com/repos/ftdysa/forever-guild/commits/abc123/pulls");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer gh-token");
  assert.equal(calls[1].url, ENV.DISCORD_WEBHOOK_URL);
  const payload = JSON.parse(String(calls[1].init?.body));
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.embeds[0].title, "Feat/sweat factor");
  assert.equal(payload.embeds[0].description, "Hello guild");
  assert.equal(payload.embeds[0].url, "https://example.test");
});

test("announce posts nothing without a webhook, a merged PR, or a notes section", async () => {
  const noHook = fake({ pulls: [merged("## Release notes\nHi")] });
  assert.equal(await announce({ ...ENV, DISCORD_WEBHOOK_URL: "" }, noHook.fetchFn, noHook.log), "skipped");
  assert.equal(noHook.calls.length, 0);

  const unmerged = fake({ pulls: [{ ...merged("## Release notes\nHi"), merged_at: null }] });
  assert.equal(await announce(ENV, unmerged.fetchFn, unmerged.log), "skipped");
  assert.equal(unmerged.calls.length, 1);

  const noNotes = fake({ pulls: [merged("Just a refactor")] });
  assert.equal(await announce(ENV, noNotes.fetchFn, noNotes.log), "skipped");
  assert.deepEqual(noNotes.logs, ["PR #17 has no release notes; nothing to post"]);
  assert.equal(noNotes.calls.length, 1);
});

test("announce never throws: GitHub and Discord failures are reported, not raised", async () => {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  assert.equal(await announce(ENV, fake({ githubStatus: 500 }).fetchFn, log), "failed");
  assert.equal(await announce(ENV, fake({ pulls: [merged("## Release notes\nHi")], webhookStatus: 400 }).fetchFn, log), "failed");
  const throwing = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal(await announce(ENV, throwing, log), "failed");
  assert.deepEqual(logs, [
    "::warning::release note: GitHub returned 500 looking up the PR",
    "::warning::release note: Discord returned 400",
    "::warning::release note: fetch failed",
  ]);
  // The webhook URL is a secret: it never reaches the logs.
  assert.ok(logs.every((l) => !l.includes("secret-token")));
});

# Release Notes to Discord — Design

Date: 2026-11-06.

## Decisions (from brainstorming)

- Release notes are written by hand in the PR description under a `## Release notes` heading.
  PRs without that section announce nothing.
- They are posted to the guild's Discord webhook by a job that runs after a successful deploy.
- The webhook URL is a `production` environment secret, `DISCORD_WEBHOOK_URL`, set by the repo
  owner. The site link comes from an optional `SITE_URL` repository variable.

## Behaviour

- **Trigger:** a new `announce` job in `.github/workflows/deploy.yml`. It runs with
  `needs: deploy` and `if: github.event_name == 'push'`, so a manual `workflow_dispatch`
  re-deploy doesn't announce twice. Permissions: `contents: read`, `pull-requests: read`.
- **Finding the PR:** `GET /repos/{repo}/commits/{sha}/pulls` with `GITHUB_TOKEN`; the first
  result with `merged_at` set. No PR (a direct push) → nothing is posted.
- **Extracting notes:** the text after a line that is `## Release notes` (case-insensitive), up to
  the next `## ` heading (an `###` heading doesn't end it) or the end of the body.
  - HTML comments are removed, so the template's prompt never posts.
  - The result is trimmed. If it is empty, `none`, `n/a` or `-` (any case), nothing is posted.
- **Embed:**
  - Title: the PR title, unless the notes start with a `### Heading` line. Then that heading is
    the title and is removed from the description. The title is capped at 256 characters.
  - Description: the notes, cut to 4096 characters and ending in `…` when cut.
  - Colour: gold, `0xD4A017`.
  - `url` is `SITE_URL` when set. `timestamp` is the post time.
  - Sent with `allowed_mentions: { parse: [] }`, so it pings nobody.
- **Failure handling:** the script never fails the job. A missing secret, a GitHub API error, or a
  Discord error each logs a `::warning::` line and exits 0. Logs never include the webhook URL.

## Components

- `scripts/release-note.mjs`: plain Node 22 with no dependencies, so the job needs no `npm ci`.
  - It exports `extractReleaseNotes(body)`, `buildReleaseEmbed({ prTitle, notes, siteUrl, at })`
    and `announce(env, fetchFn)`.
  - It runs `announce(process.env, fetch)` when executed directly.
- `test/release-note.test.ts`: tests for extraction, the embed, and `announce` with a fake `fetch`.
- `.github/pull_request_template.md`: a `## Release notes` section with a comment prompt.
- `eslint.config.js`: Node globals for `scripts/**/*.mjs`.
- README: a line under "CI / deploy" about the section and the secret.

## Out of scope

- Generating notes automatically (with an LLM or from commit messages).
- Editing or deleting a Discord post after it is sent.

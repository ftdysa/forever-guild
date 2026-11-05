import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { BlizzardClient, BlizzardError, type FetchFn } from "../src/blizzard.js";
import { fakeBlizzard } from "./fake-blizzard.js";

const creds = { clientId: "id", clientSecret: "shh", region: "us", namespace: "classic1x" };

test("builds the profile namespace per game flavor", () => {
  assert.equal(new BlizzardClient(creds).profileNamespace, "profile-classic1x-us");
  assert.equal(new BlizzardClient({ ...creds, namespace: "classic", region: "eu" }).profileNamespace, "profile-classic-eu");
  assert.equal(new BlizzardClient({ ...creds, namespace: "retail" }).profileNamespace, "profile-us");
});

test("sends basic auth to oauth and the namespace to the api", async () => {
  const seen: { url: string; auth: string | null; body?: unknown }[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: init?.body });
    return String(input).startsWith("https://oauth.battle.net")
      ? Response.json({ access_token: "t1", expires_in: 3600 })
      : Response.json({ ok: true });
  };
  assert.deepEqual(await new BlizzardClient(creds, fetchFn).profile("/x"), { ok: true });
  assert.equal(seen[0].auth, `Basic ${Buffer.from("id:shh").toString("base64")}`);
  assert.equal(seen[0].body, "grant_type=client_credentials");
  assert.equal(seen[1].url, "https://us.api.blizzard.com/x?namespace=profile-classic1x-us&locale=en_US");
  assert.equal(seen[1].auth, "Bearer t1");
});

test("caches the token until shortly before expiry", async () => {
  let t = 0;
  const fake = fakeBlizzard({ "/a": { n: 1 } });
  fake.state.expiresIn = 3600;
  const client = new BlizzardClient(creds, fake.fetchFn, () => t);
  await client.profile("/a");
  await client.profile("/a");
  assert.equal(fake.tokens(), 1);
  t = 3600 * 1000 - 30_000; // inside the refresh margin
  await client.profile("/a");
  assert.equal(fake.tokens(), 2);
});

test("concurrent first requests share one token fetch", async () => {
  const fake = fakeBlizzard({ "/a": {} });
  const client = new BlizzardClient(creds, fake.fetchFn, undefined, async () => {});
  await Promise.all([client.profile("/a"), client.profile("/a"), client.profile("/a")]);
  assert.equal(fake.tokens(), 1);
});

test("404 resolves null; other errors throw BlizzardError without leaking secrets", async () => {
  const fake = fakeBlizzard({ "/boom": { status: 503 } });
  const client = new BlizzardClient(creds, fake.fetchFn, undefined, async () => {});
  assert.equal(await client.profile("/missing"), null);
  await assert.rejects(client.profile("/boom"), (e: unknown) => e instanceof BlizzardError && !/shh|tok-/.test(String(e)));
});

test("network failures and oauth failures become BlizzardError", async () => {
  const down = fakeBlizzard();
  down.state.apiDown = true;
  await assert.rejects(new BlizzardClient(creds, down.fetchFn, undefined, async () => {}).profile("/a"), BlizzardError);

  const badCreds = fakeBlizzard();
  badCreds.state.tokenStatus = 401;
  await assert.rejects(new BlizzardClient(creds, badCreds.fetchFn, undefined, async () => {}).profile("/a"), /oauth returned 401/);
});

test("a 401 from the api refreshes the token and retries once", async () => {
  let apiCalls = 0;
  let tokens = 0;
  const fetchFn: FetchFn = async (input, init) => {
    if (String(input).startsWith("https://oauth.battle.net")) return Response.json({ access_token: `t${++tokens}`, expires_in: 3600 });
    apiCalls++;
    return new Headers(init?.headers).get("authorization") === "Bearer t2" ? Response.json({ ok: 1 }) : new Response("", { status: 401 });
  };
  assert.deepEqual(await new BlizzardClient(creds, fetchFn).profile("/a"), { ok: 1 });
  assert.equal(apiCalls, 2);
  assert.equal(tokens, 2);
});

test("profileIfModified sends If-Modified-Since and maps 304 / 200 / 404", async () => {
  const fake = fakeBlizzard({ "/c": { name: "Jaina" } });
  const client = new BlizzardClient(creds, fake.fetchFn, undefined, async () => {});
  const first = await client.profileIfModified<{ name: string }>("/c", null);
  assert.deepEqual(first, { modified: true, body: { name: "Jaina" }, lastModified: fake.state.lastModified });
  assert.deepEqual(await client.profileIfModified("/c", fake.state.lastModified), { modified: false });
  assert.deepEqual(await client.profileIfModified("/c", "Thu, 01 Jan 2026 00:00:00 GMT"), {
    modified: true,
    body: { name: "Jaina" },
    lastModified: fake.state.lastModified,
  });
  assert.deepEqual(await client.profileIfModified("/missing", null), { modified: true, body: null, lastModified: null });
});

const isToken = (input: unknown) => String(input).startsWith("https://oauth.battle.net");

// Fake fetch: token calls succeed; API calls pop the next scripted response (last one repeats).
function scripted(responses: (() => Response)[]) {
  let apiCalls = 0;
  const fetchFn: FetchFn = async (input) => {
    if (isToken(input)) return Response.json({ access_token: "t", expires_in: 3600 });
    const make = responses[Math.min(apiCalls, responses.length - 1)];
    apiCalls++;
    return make();
  };
  return { fetchFn, calls: () => apiCalls };
}

test("a 429 is retried after Retry-After seconds", async () => {
  const f = scripted([() => new Response("", { status: 429, headers: { "retry-after": "2" } }), () => Response.json({ ok: 1 })]);
  const sleeps: number[] = [];
  const client = new BlizzardClient(creds, f.fetchFn, () => 0, async (ms) => void sleeps.push(ms));
  assert.deepEqual(await client.gameData("/a"), { ok: 1 });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(f.calls(), 2);
});

test("a 429 without Retry-After backs off 1s then 2s", async () => {
  const f = scripted([() => new Response("", { status: 429 }), () => new Response("", { status: 429 }), () => Response.json({ ok: 1 })]);
  const sleeps: number[] = [];
  const client = new BlizzardClient(creds, f.fetchFn, () => 0, async (ms) => void sleeps.push(ms));
  assert.deepEqual(await client.gameData("/a"), { ok: 1 });
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("gives up after three 429 retries", async () => {
  const f = scripted([() => new Response("", { status: 429 })]);
  const client = new BlizzardClient(creds, f.fetchFn, () => 0, async () => {});
  await assert.rejects(client.gameData("/a"), (e: unknown) => e instanceof BlizzardError && /429/.test(e.message));
  assert.equal(f.calls(), 4);
});

test("caps request starts at 50 per rolling second", async () => {
  let clock = 0;
  const starts: number[] = [];
  const fetchFn: FetchFn = async (input) => {
    if (isToken(input)) return Response.json({ access_token: "t", expires_in: 3600 });
    starts.push(clock);
    return Response.json({ ok: 1 });
  };
  const client = new BlizzardClient(creds, fetchFn, () => clock, async (ms) => void (clock += ms));
  await Promise.all(Array.from({ length: 120 }, () => client.gameData("/a")));
  assert.equal(starts.length, 120);
  for (let i = 0; i + 50 < starts.length; i++) {
    assert.ok(starts[i + 50] - starts[i] >= 1000, `requests ${i}..${i + 50} started within 1s`);
  }
});

test("a transient fetch rejection is retried after 1s", async () => {
  let apiCalls = 0;
  const fetchFn: FetchFn = async (input) => {
    if (isToken(input)) return Response.json({ access_token: "t", expires_in: 3600 });
    if (apiCalls++ === 0) throw new TypeError("fetch failed");
    return Response.json({ ok: 1 });
  };
  const sleeps: number[] = [];
  const client = new BlizzardClient(creds, fetchFn, () => 0, async (ms) => void sleeps.push(ms));
  assert.deepEqual(await client.gameData("/a"), { ok: 1 });
  assert.deepEqual(sleeps, [1000]);
});

test("persistent fetch rejection throws unreachable with the cause code, after 4 calls", async () => {
  let apiCalls = 0;
  const fetchFn: FetchFn = async (input) => {
    if (isToken(input)) return Response.json({ access_token: "tok-secret", expires_in: 3600 });
    apiCalls++;
    throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  };
  const client = new BlizzardClient(creds, fetchFn, () => 0, async () => {});
  await assert.rejects(
    client.gameData("/a"),
    (e: unknown) => e instanceof BlizzardError && /unreachable \(ECONNRESET\)/.test(e.message) && !/tok-secret|shh|Bearer/.test(e.message),
  );
  assert.equal(apiCalls, 4);
});

test("a 503 is retried; a 404 is not", async () => {
  const f = scripted([() => new Response("", { status: 503 }), () => Response.json({ ok: 1 })]);
  const sleeps: number[] = [];
  const client = new BlizzardClient(creds, f.fetchFn, () => 0, async (ms) => void sleeps.push(ms));
  assert.deepEqual(await client.gameData("/a"), { ok: 1 });
  assert.deepEqual(sleeps, [1000]);

  const g = scripted([() => new Response("", { status: 404 })]);
  assert.equal(await new BlizzardClient(creds, g.fetchFn, () => 0, async () => {}).gameData("/a"), null);
  assert.equal(g.calls(), 1);
});

test("a timeout is retried once, then throws", async () => {
  let clock = 0;
  let apiCalls = 0;
  const fetchFn: FetchFn = async (input) => {
    if (isToken(input)) return Response.json({ access_token: "t", expires_in: 3600 });
    apiCalls++;
    clock += 10_000;
    throw new DOMException("timed out", "TimeoutError");
  };
  const client = new BlizzardClient(creds, fetchFn, () => clock, async (ms) => void (clock += ms));
  await assert.rejects(client.gameData("/a"), (e: unknown) => e instanceof BlizzardError && /unreachable \(TimeoutError\)/.test(e.message));
  assert.equal(apiCalls, 2);
});

test("retries stop once the 15s per-request budget would be exceeded", async () => {
  let clock = 0;
  const f = scripted([() => new Response("", { status: 503, headers: { "retry-after": "10" } })]);
  const client = new BlizzardClient(creds, f.fetchFn, () => clock, async (ms) => void (clock += ms));
  await assert.rejects(client.gameData("/a"), /503/);
  assert.ok(f.calls() <= 2, `calls ${f.calls()}`);
  assert.ok(clock < 25_000, `elapsed ${clock}`);
});

test("a 5xx Retry-After is honoured", async () => {
  const f = scripted([() => new Response("", { status: 503, headers: { "retry-after": "2" } }), () => Response.json({ ok: 1 })]);
  const sleeps: number[] = [];
  const client = new BlizzardClient(creds, f.fetchFn, () => 0, async (ms) => void sleeps.push(ms));
  assert.deepEqual(await client.gameData("/a"), { ok: 1 });
  assert.deepEqual(sleeps, [2000]);
});

test("each attempt's timeout is bounded by the remaining budget", async () => {
  let clock = 0;
  let apiCalls = 0;
  const timeouts: number[] = [];
  const spy = mock.method(AbortSignal, "timeout", (ms: number) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  try {
    const fetchFn: FetchFn = async (input) => {
      if (isToken(input)) return Response.json({ access_token: "t", expires_in: 3600 });
      apiCalls++;
      if (apiCalls === 1) {
        clock += 9_000; // slow 503, then a 1 s backoff: 10 s spent, 5 s of budget left
        return new Response("", { status: 503 });
      }
      return Response.json({ ok: 1 });
    };
    const client = new BlizzardClient(creds, fetchFn, () => clock, async (ms) => void (clock += ms));
    assert.deepEqual(await client.gameData("/a"), { ok: 1 });
  } finally {
    spy.mock.restore();
  }
  // [0] is the token request; then the API attempts.
  assert.deepEqual(timeouts.slice(1), [10_000, 5_000]);
});

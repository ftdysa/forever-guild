import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sessionCookieName } from "../src/routes/auth.js";

const PASS = "for-the-horde-forever";
const base = { port: 0, dbPath: ":memory:", guildPassphrase: PASS, sessionSecret: "x".repeat(40), cookieSecure: false };

async function login(a: FastifyInstance) {
  const res = await a.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
  const name = sessionCookieName(false);
  return { [name]: res.cookies.find((c) => c.name === name)!.value };
}

test("progress requires a session", async () => {
  const app = buildApp(base);
  await app.ready();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/progress" })).statusCode, 401);
  } finally {
    await app.close();
  }
});

test("progress reports stored history, flagging former members", async () => {
  const app = buildApp(base);
  await app.ready();
  try {
    const cookies = await login(app);
    const empty = (await app.inject({ method: "GET", url: "/api/progress", cookies })).json();
    assert.equal(empty.trackingSince, null);
    assert.deepEqual(empty.series, []);

    app.store.syncRoster([{ name: "Grom", surname: "Hellscream", slug: null, classId: "warrior", level: 42, rank: 4 }]);
    app.progress.upsertSnapshot("Grom Hellscream", "2026-11-05", { classId: "warrior", level: 42 });
    app.progress.upsertSnapshot("Gone", "2026-11-05", { classId: "mage", level: 12 });
    const res = await app.inject({ method: "GET", url: "/api/progress", cookies });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.trackingSince, "2026-11-05");
    assert.deepEqual(body.series.map((s: { name: string; current: boolean }) => [s.name, s.current]), [["Gone", false], ["Grom Hellscream", true]]);
    assert.deepEqual(body.links, { "grom hellscream": { characterName: "Grom", surname: "Hellscream" } });
  } finally {
    await app.close();
  }
});

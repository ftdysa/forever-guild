import type { FastifyPluginCallback } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const loginRoute: FastifyPluginCallback = (app, _opts, done) => {
  app.post<{ Body: { passphrase?: unknown } }>("/login", async (req, reply) => {
    const passphrase = req.body?.passphrase;
    if (typeof passphrase !== "string") {
      return reply.code(400).send({ error: "passphrase is required" });
    }
    if (!safeEqual(passphrase, app.config.guildPassphrase)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    reply.setCookie(SESSION_COOKIE, randomBytes(16).toString("hex"), {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return reply.code(204).send();
  });

  done();
};

export const logoutRoute: FastifyPluginCallback = (app, _opts, done) => {
  app.post("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  done();
};

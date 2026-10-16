import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { SESSION_TTL_MS } from "../sessions.js";
import { audit } from "../audit.js";

// The __Host- prefix stops subdomains from planting or overwriting the cookie, but
// browsers only accept it on Secure cookies, so plain-HTTP dev keeps the bare name.
export const sessionCookieName = (secure: boolean) => (secure ? "__Host-session" : "session");

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Returns the session token if the cookie is correctly signed, else null.
export function readSessionToken(req: FastifyRequest): string | null {
  const raw = req.cookies[sessionCookieName(req.server.config.cookieSecure)];
  if (!raw) return null;
  const { valid, value } = req.unsignCookie(raw);
  return valid ? value : null;
}

export const loginRoute: FastifyPluginCallback = (app, _opts, done) => {
  app.post<{ Body: { passphrase?: unknown } }>(
    "/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const passphrase = req.body?.passphrase;
      if (typeof passphrase !== "string") {
        return reply.code(400).send({ error: "passphrase is required" });
      }
      if (!safeEqual(passphrase, app.config.guildPassphrase)) {
        audit(req, "login.failed");
        return reply.code(401).send({ error: "unauthorized" });
      }
      audit(req, "login.ok");
      reply.setCookie(sessionCookieName(app.config.cookieSecure), app.sessions.create(), {
        signed: true,
        httpOnly: true,
        sameSite: "lax",
        secure: app.config.cookieSecure,
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
      });
      return reply.code(204).send();
    },
  );

  done();
};

export const logoutRoute: FastifyPluginCallback = (app, _opts, done) => {
  app.post("/logout", async (req, reply) => {
    const token = readSessionToken(req);
    if (token) app.sessions.revoke(token);
    reply.clearCookie(sessionCookieName(app.config.cookieSecure), { path: "/", secure: app.config.cookieSecure });
    return reply.code(204).send();
  });

  done();
};

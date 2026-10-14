import type { FastifyPluginCallback } from "fastify";
import { validateMember } from "../validate.js";
import { DuplicateNameError } from "../db.js";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export const memberRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/members", async () => app.store.list());

  app.post("/members", async (req, reply) => {
    const v = validateMember(req.body);
    if (!v.ok) return reply.code(400).send({ error: "validation failed", details: v.errors });
    try {
      return reply.code(201).send(app.store.create(v.value));
    } catch (err) {
      if (err instanceof DuplicateNameError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>("/members/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid id" });
    const v = validateMember(req.body);
    if (!v.ok) return reply.code(400).send({ error: "validation failed", details: v.errors });
    try {
      const updated = app.store.update(id, v.value);
      if (!updated) return reply.code(404).send({ error: "not found" });
      return updated;
    } catch (err) {
      if (err instanceof DuplicateNameError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/members/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid id" });
    if (!app.store.delete(id)) return reply.code(404).send({ error: "not found" });
    return reply.code(204).send();
  });

  done();
};

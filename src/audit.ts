import type { FastifyRequest } from "fastify";

// Everyone shares one passphrase, so the client IP is the best "who" we have.
export function audit(req: FastifyRequest, action: string, fields: Record<string, unknown> = {}): void {
  req.log.info({ audit: action, ip: req.server.clientIp(req), ...fields }, action);
}

import type { FastifyRequest } from "fastify";
import { Errors } from "../../lib/errors.js";
import type { Principal } from "./session.service.js";

/** The authenticated caller; only valid on routes guarded by `app.authorize(...)`. */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw Errors.unauthorized();
  return request.principal;
}

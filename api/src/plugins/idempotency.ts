import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { canonicalJson, sha256Hex } from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";

export type IdempotencyOptions = {
  /** Reject requests without an Idempotency-Key header (default true). */
  required?: boolean;
  /** How long a completed response is replayable, in seconds (default 24h). */
  ttlSeconds?: number;
};

export type IdempotencyState = {
  key: string;
  fingerprint: string;
  ttlSeconds: number;
  stored: boolean;
};

type StoredRecord =
  | { state: "processing"; fingerprint: string }
  | { state: "completed"; fingerprint: string; statusCode: number; contentType: string | null; body: string };

const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
const MAX_STORED_BYTES = 1_048_576;

function parseRecord(raw: string | null): StoredRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredRecord;
    return value && typeof value.fingerprint === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * `Idempotency-Key` support (PRD §7). The first request with a key runs; while
 * it is in flight duplicates get 409; once it completes, a retry with the same
 * payload replays the stored response and a different payload gets 409.
 * 5xx outcomes are not stored, so the client may retry. Database unique
 * constraints on idempotency keys remain the final guard for money writes.
 */
export default fp(
  async (app) => {
    const lockTtlSeconds = Math.ceil((app.config.requestTimeoutMs * 2) / 1000);
    app.decorateRequest("idempotency", null);

    app.decorate("idempotent", (options: IdempotencyOptions = {}) => async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers["idempotency-key"];
      const supplied = Array.isArray(header) ? header[0] : header;
      if (!supplied) {
        if (options.required === false) return;
        throw Errors.badRequest("Idempotency-Key header is required for this request", "IDEMPOTENCY_KEY_REQUIRED");
      }
      if (!KEY_PATTERN.test(supplied)) {
        throw Errors.badRequest("Idempotency-Key must be 8-128 characters of letters, digits, '-', '_', ':' or '.'", "IDEMPOTENCY_KEY_INVALID");
      }

      const scope = request.principal?.userId ?? `ip:${request.ip}`;
      const key = `idem:${sha256Hex(`${request.method}|${request.routeOptions.url ?? request.url}|${scope}|${supplied}`)}`;
      const fingerprint = sha256Hex(canonicalJson({ params: request.params ?? null, query: request.query ?? null, body: request.body ?? null }));

      let acquired: string | null;
      let existing: StoredRecord | null = null;
      try {
        acquired = await app.redis.set(key, JSON.stringify({ state: "processing", fingerprint }), "EX", lockTtlSeconds, "NX");
        if (!acquired) existing = parseRecord(await app.redis.get(key));
      } catch (error) {
        request.log.error({ err: error }, "idempotency store unavailable");
        throw Errors.unavailable("Request deduplication is temporarily unavailable; retry shortly", "IDEMPOTENCY_UNAVAILABLE");
      }

      if (acquired) {
        request.idempotency = { key, fingerprint, ttlSeconds: options.ttlSeconds ?? 86_400, stored: false };
        return;
      }
      if (!existing) throw Errors.conflict("A request with this Idempotency-Key is being processed; retry shortly", "IDEMPOTENCY_IN_PROGRESS");
      if (existing.fingerprint !== fingerprint) {
        throw Errors.conflict("This Idempotency-Key was already used with a different request", "IDEMPOTENCY_KEY_REUSED");
      }
      if (existing.state === "processing") {
        reply.header("retry-after", "1");
        throw Errors.conflict("A request with this Idempotency-Key is being processed; retry shortly", "IDEMPOTENCY_IN_PROGRESS");
      }
      reply.header("idempotent-replayed", "true");
      if (existing.contentType) reply.header("content-type", existing.contentType);
      return reply.status(existing.statusCode).send(existing.body);
    });

    app.addHook("onSend", async (request, reply, payload) => {
      const state = request.idempotency;
      if (!state || state.stored || reply.statusCode >= 500) return payload;
      let body: string | null = null;
      if (typeof payload === "string") body = payload;
      else if (Buffer.isBuffer(payload)) body = payload.toString("utf8");
      else if (payload === null || payload === undefined) body = "";
      if (body === null || Buffer.byteLength(body) > MAX_STORED_BYTES) return payload;

      const contentType = reply.getHeader("content-type");
      const record: StoredRecord = {
        state: "completed",
        fingerprint: state.fingerprint,
        statusCode: reply.statusCode,
        contentType: typeof contentType === "string" ? contentType : null,
        body,
      };
      try {
        await app.redis.set(state.key, JSON.stringify(record), "EX", state.ttlSeconds);
        state.stored = true;
      } catch (error) {
        request.log.error({ err: error }, "failed to store idempotent response");
      }
      return payload;
    });

    // Release the in-flight lock when nothing was stored (5xx, aborted or unstorable response).
    app.addHook("onResponse", async (request) => {
      const state = request.idempotency;
      if (!state || state.stored) return;
      try {
        await app.redis.del(state.key);
      } catch (error) {
        request.log.warn({ err: error }, "failed to release idempotency lock");
      }
    });
  },
  { name: "idempotency", dependencies: ["redis"] },
);

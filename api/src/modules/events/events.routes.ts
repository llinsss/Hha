import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { ServerResponse } from "node:http";
import { Type } from "typebox";
import { withConnection } from "../../db/sql.js";
import { Errors } from "../../lib/errors.js";
import { canSeeEvent } from "../../lib/events.js";
import { errorResponses } from "../../lib/schemas.js";
import { requirePrincipal } from "../auth/principal.js";
import { OUTBOX_EVENT_SELECT, OutboxRelay, toOutboxEvent, type OutboxEvent } from "./outbox-relay.js";

const HEARTBEAT_MS = 15_000;
const SESSION_RECHECK_MS = 60_000;
const MAX_STREAMS_PER_USER = 5;
const REPLAY_LIMIT = 500;
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Server-sent events of committed property changes (PRD §7/§9). Clients send
 * the bearer token (fetch-based EventSource) and reconnect with `Last-Event-ID`
 * or `?cursor=` to replay what they missed. Events carry only type, entity id
 * and reference, filtered by the caller's role; clients refetch details through
 * the authorised endpoints. Streams end when the access token expires or the
 * session is revoked, so the client must reconnect with a fresh token.
 */
const eventRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const relay = new OutboxRelay(app.db, app.log.child({ module: "outbox-relay" }));
  const open = new Map<string, Set<ServerResponse>>();
  app.addHook("preClose", async () => {
    relay.close();
    for (const streams of open.values()) for (const stream of streams) stream.end();
  });

  app.get(
    "/",
    {
      preHandler: app.authorize(),
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      schema: {
        tags: ["events"],
        summary: "Live stream of property updates (text/event-stream)",
        security: [{ bearerAuth: [] }],
        headers: Type.Object({ "last-event-id": Type.Optional(Type.String({ pattern: "^\\d{1,18}$" })) }),
        querystring: Type.Object({ cursor: Type.Optional(Type.String({ pattern: "^\\d{1,18}$" })) }, { additionalProperties: false }),
        response: { 200: Type.String({ description: "text/event-stream" }), ...errorResponses(401, 403, 429) },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const streams = open.get(principal.userId) ?? new Set<ServerResponse>();
      if (streams.size >= MAX_STREAMS_PER_USER) throw Errors.tooManyRequests("Too many open event streams for this account", "TOO_MANY_STREAMS");
      const requested = request.headers["last-event-id"] ?? request.query.cursor;

      const raw = reply.raw;
      let lastSent = 0n;
      let replaying = true;
      const buffered: OutboxEvent[] = [];
      const write = (event: OutboxEvent) => {
        if (event.id <= lastSent || event.propertyId !== principal.propertyId) return;
        lastSent = event.id;
        if (!canSeeEvent(principal.role, event.type)) return;
        raw.write(`id: ${event.id}\nevent: property-update\ndata: ${JSON.stringify({ type: event.type, entityId: event.entityId, reference: event.reference, at: event.at })}\n\n`);
        // A client that stops reading must not grow server memory without bound.
        if (raw.writableLength > MAX_BUFFERED_BYTES) raw.destroy();
      };
      // Live events wait until the replay below has been written, preserving order.
      const subscription = await relay.subscribe((event) => (replaying ? buffered.push(event) : write(event)));

      reply.hijack();
      // Hijacked replies skip Fastify's send path, so carry over CORS, security and request-id headers.
      for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) raw.setHeader(name, value);
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      streams.add(raw);
      open.set(principal.userId, streams);

      const from = requested !== undefined ? BigInt(requested) : subscription.head;
      lastSent = from;
      if (from < subscription.head) {
        const missed = await withConnection(app.db, (sql) =>
          sql.rows<Parameters<typeof toOutboxEvent>[0]>(
            `${OUTBOX_EVENT_SELECT} WHERE property_id = $1 AND id > $2 AND id <= $3 ORDER BY id LIMIT $4`,
            [principal.propertyId, String(from), String(subscription.head), REPLAY_LIMIT],
          ),
        );
        for (const row of missed) write(toOutboxEvent(row));
        // More was missed than we replay: tell the client to refetch everything.
        if (missed.length === REPLAY_LIMIT) raw.write(`event: resync\ndata: {}\n\n`);
        if (lastSent < subscription.head) lastSent = subscription.head;
      }
      replaying = false;
      for (const event of buffered.splice(0)) write(event);
      raw.write(`event: ready\ndata: ${JSON.stringify({ cursor: String(lastSent), at: new Date() })}\n\n`);

      const heartbeat = setInterval(() => raw.write(`: keepalive\n\n`), HEARTBEAT_MS);
      const recheck = setInterval(() => {
        void app.sessions.resolvePrincipal(principal.sessionId, principal.userId).then(
          (current) => {
            if (!current) raw.end();
          },
          () => undefined,
        );
      }, SESSION_RECHECK_MS);
      const tokenExpiry = typeof request.user.exp === "number" ? request.user.exp * 1000 - Date.now() : 0;
      const expiry = setTimeout(() => raw.end(), Math.max(tokenExpiry, 0));

      raw.on("close", () => {
        clearInterval(heartbeat);
        clearInterval(recheck);
        clearTimeout(expiry);
        subscription.unsubscribe();
        streams.delete(raw);
        if (streams.size === 0) open.delete(principal.userId);
      });
    },
  );
};

export default eventRoutes;

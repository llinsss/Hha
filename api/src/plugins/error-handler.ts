import { STATUS_CODES } from "node:http";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { QueryFailedError } from "typeorm";
import { AppError } from "../lib/errors.js";
import type { ErrorResponse } from "../lib/schemas.js";

type Normalised = { statusCode: number; code: string; message: string; details?: ReadonlyArray<{ path: string; message: string }>; expose: boolean };

/** PostgreSQL SQLSTATE codes we translate into client errors. */
const PG_ERRORS: Record<string, Omit<Normalised, "details">> = {
  "23505": { statusCode: 409, code: "UNIQUE_VIOLATION", message: "A record with these details already exists", expose: true },
  "23503": { statusCode: 409, code: "REFERENCE_VIOLATION", message: "A related record does not exist or is still in use", expose: true },
  "23514": { statusCode: 422, code: "CHECK_VIOLATION", message: "The request violates a data rule", expose: true },
  "22P02": { statusCode: 422, code: "INVALID_INPUT_SYNTAX", message: "A value has an invalid format", expose: true },
  "40001": { statusCode: 409, code: "SERIALIZATION_FAILURE", message: "The request conflicted with a concurrent change; retry it", expose: true },
  "40P01": { statusCode: 409, code: "DEADLOCK_DETECTED", message: "The request conflicted with a concurrent change; retry it", expose: true },
  "57014": { statusCode: 503, code: "QUERY_TIMEOUT", message: "The request took too long; retry it", expose: true },
};

function normalise(error: unknown): Normalised {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), expose: true };
  }
  if (error instanceof QueryFailedError) {
    const sqlState = (error.driverError as { code?: unknown } | undefined)?.code;
    const mapped = typeof sqlState === "string" ? PG_ERRORS[sqlState] : undefined;
    if (mapped) return { ...mapped };
    return { statusCode: 500, code: "INTERNAL_ERROR", message: "Internal Server Error", expose: false };
  }
  const fastifyError = error as Partial<FastifyError> | undefined;
  if (fastifyError?.validation) {
    const context = fastifyError.validationContext ?? "request";
    return {
      statusCode: 422,
      code: "VALIDATION_FAILED",
      message: "The request is invalid",
      details: fastifyError.validation.map((issue) => ({
        path: `${context}${issue.instancePath || ""}`,
        message: issue.message ?? "is invalid",
      })),
      expose: true,
    };
  }
  const status = typeof fastifyError?.statusCode === "number" ? fastifyError.statusCode : 500;
  if (status >= 400 && status < 500) {
    const message = fastifyError?.message;
    return {
      statusCode: status,
      code: fastifyError?.code ?? STATUS_CODES[status]?.toUpperCase().replace(/\W+/g, "_") ?? "CLIENT_ERROR",
      message: message !== undefined && message.length > 0 ? message : (STATUS_CODES[status] ?? "Bad Request"),
      expose: true,
    };
  }
  if (status === 503) return { statusCode: 503, code: fastifyError?.code ?? "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", expose: true };
  return { statusCode: status >= 500 && status < 600 ? status : 500, code: "INTERNAL_ERROR", message: "Internal Server Error", expose: false };
}

export function buildErrorBody(request: FastifyRequest, error: Normalised): ErrorResponse {
  return {
    statusCode: error.statusCode,
    error: STATUS_CODES[error.statusCode] ?? "Error",
    code: error.code,
    message: error.message,
    requestId: request.id,
    ...(error.details ? { details: [...error.details] } : {}),
  };
}

/**
 * Converts every thrown error into the standard envelope. 5xx responses never
 * reveal internal messages; the full error is logged with the request id.
 */
export default fp(
  async (app) => {
    app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
      const normalised = normalise(error);
      if (normalised.statusCode >= 500 && !normalised.expose) request.log.error({ err: error }, "request failed");
      else if (normalised.statusCode >= 500) request.log.warn({ err: error }, "request failed");
      else request.log.info({ code: normalised.code, statusCode: normalised.statusCode }, "request rejected");
      return reply.status(normalised.statusCode).send(buildErrorBody(request, normalised));
    });

    app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) =>
      reply.status(404).send(
        buildErrorBody(request, { statusCode: 404, code: "ROUTE_NOT_FOUND", message: `Route ${request.method} ${request.url.split("?")[0] ?? ""} not found`, expose: true }),
      ),
    );
  },
  { name: "error-handler", dependencies: ["@fastify/rate-limit"] },
);

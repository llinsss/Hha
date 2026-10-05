/**
 * Application error carrying an HTTP status and a stable machine-readable code.
 * Throw these from services; the global error handler turns them into the
 * standard error envelope. Messages of 4xx errors are shown to clients, so keep
 * them free of internal detail.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  badRequest: (message: string, code = "BAD_REQUEST") => new AppError(400, code, message),
  unauthorized: (message = "Authentication required", code = "UNAUTHORIZED") => new AppError(401, code, message),
  forbidden: (message = "You do not have access to this action", code = "FORBIDDEN") => new AppError(403, code, message),
  notFound: (message = "Resource not found", code = "NOT_FOUND") => new AppError(404, code, message),
  conflict: (message: string, code = "CONFLICT") => new AppError(409, code, message),
  unprocessable: (message: string, code = "UNPROCESSABLE_ENTITY") => new AppError(422, code, message),
  tooManyRequests: (message: string, code = "TOO_MANY_REQUESTS") => new AppError(429, code, message),
  unavailable: (message = "Service temporarily unavailable", code = "SERVICE_UNAVAILABLE") => new AppError(503, code, message),
} as const;

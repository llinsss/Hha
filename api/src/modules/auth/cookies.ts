import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config/env.js";
import { Errors } from "../../lib/errors.js";

export const REFRESH_COOKIE = "hh_refresh";

function baseOptions(config: AppConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    // Scope the refresh token to the auth endpoints so it is never sent elsewhere.
    path: `${config.apiPrefix}/auth`,
    ...(config.cookie.domain ? { domain: config.cookie.domain } : {}),
  };
}

export function setRefreshCookie(reply: FastifyReply, config: AppConfig, token: string, expiresAt: Date): void {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(REFRESH_COOKIE, token, { ...baseOptions(config), maxAge });
}

export function clearRefreshCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(REFRESH_COOKIE, baseOptions(config));
}

/**
 * CSRF defence for the cookie-authenticated endpoints (refresh, logout). Browser
 * requests must come from an allowlisted origin; non-browser clients that send
 * no Origin and no Sec-Fetch-Site header are allowed through.
 */
export function assertTrustedOrigin(request: FastifyRequest, config: AppConfig): void {
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (!config.corsOrigins.includes(origin)) throw Errors.forbidden("Request origin is not allowed", "ORIGIN_NOT_ALLOWED");
    return;
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") throw Errors.forbidden("Cross-site request rejected", "ORIGIN_NOT_ALLOWED");
}

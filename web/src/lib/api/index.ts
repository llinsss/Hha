import type { ApiClient } from "./client";
import { createHttpClient } from "./http";
import { createSampleClient } from "./sample-client";

export * from "./client";
export type * from "./types";

/**
 * The single ApiClient used by the whole frontend.
 *
 * - `NEXT_PUBLIC_API_BASE_URL` unset (default): sample mode. The UI runs on
 *   built-in sample data and makes no network requests.
 * - `NEXT_PUBLIC_API_BASE_URL=https://api.houzzhills.com`: HTTP mode against the
 *   standalone API in ../api. Only enable it once the endpoints in http.ts exist there.
 */
function createApiClient(): ApiClient {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  return baseUrl ? createHttpClient(baseUrl) : createSampleClient();
}

export const api: ApiClient = createApiClient();

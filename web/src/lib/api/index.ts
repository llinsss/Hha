import { createHttpClient } from "./http";

export * from "./client";
export type * from "./types";

/**
 * The single ApiClient used by the whole web app. By default it calls the API
 * on the same origin (`/api/v1/*`, forwarded to the API service by
 * next.config.ts). NEXT_PUBLIC_API_BASE_URL points it at another origin instead.
 */
export const api = createHttpClient(process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ?? "");

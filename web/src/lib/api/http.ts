import { ApiError, type ApiClient } from "./client";
import type {
  CreatedPosOrder,
  Dashboard,
  InventoryItem,
  MenuItem,
  PaymentRecord,
  PosOrder,
  Receipt,
  Reservation,
  Room,
  Shift,
  Staff,
  User,
} from "./types";

/**
 * ApiClient backed by the standalone Houzz Hills API (../api).
 *
 * - Paths follow PRD §7 under the versioned prefix: legacy `/api/<path>` becomes
 *   `/api/v1/<path>`. Request and response bodies keep the legacy shapes, as the
 *   PRD requires during extraction.
 * - Auth: the short-lived access token is kept in memory only and sent as a
 *   bearer token. The refresh token is an HttpOnly cookie that only the API can
 *   read. On an expired access token the client refreshes once (single-flight)
 *   and retries the request.
 * - Money/order writes send an `Idempotency-Key` header.
 *
 * Only `/auth/*` exists in the API today. Other endpoints still need porting.
 */

type Method = "GET" | "POST" | "PATCH";
type RequestOptions = { body?: unknown; idempotencyKey?: string; authenticated?: boolean; retryOnExpiry?: boolean };
type TokenResponse = { accessToken: string; user: User };

const PREFIX = "/api/v1";
const TIMEOUT_MS = 20_000;

export function createHttpClient(baseUrl: string): ApiClient {
  const origin = baseUrl.replace(/\/+$/, "");
  let accessToken: string | null = null;
  let refreshing: Promise<boolean> | null = null;

  async function send(method: Method, path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.authenticated !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    try {
      return await fetch(`${origin}${PREFIX}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // Needed for the refresh cookie on /auth/*; harmless elsewhere.
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new ApiError(0, timedOut ? "TIMEOUT" : "NETWORK_ERROR", timedOut ? "The server took too long to respond. Try again." : "Unable to reach the Houzz Hills API. Check your connection.");
    }
  }

  async function toError(response: Response): Promise<ApiError> {
    const payload = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
    return new ApiError(response.status, payload?.code ?? `HTTP_${response.status}`, payload?.message ?? `Request failed (${response.status})`);
  }

  async function refreshAccessToken(): Promise<boolean> {
    refreshing ??= (async () => {
      try {
        const response = await send("POST", "/auth/refresh", { authenticated: false });
        if (!response.ok) {
          accessToken = null;
          return false;
        }
        accessToken = ((await response.json()) as TokenResponse).accessToken;
        return true;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await send(method, path, options);
    if (response.status === 401 && options.authenticated !== false && options.retryOnExpiry !== false && (await refreshAccessToken())) {
      return request<T>(method, path, { ...options, retryOnExpiry: false });
    }
    if (!response.ok) throw await toError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    mode: "http",

    auth: {
      async session() {
        if (!accessToken && !(await refreshAccessToken())) return null;
        try {
          return (await request<{ user: User }>("GET", "/auth/session")).user;
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) return null;
          throw error;
        }
      },
      async login(input) {
        const result = await request<TokenResponse>("POST", "/auth/login", { body: input, authenticated: false });
        accessToken = result.accessToken;
        return result.user;
      },
      async logout() {
        try {
          await request<void>("POST", "/auth/logout", { authenticated: false });
        } finally {
          accessToken = null;
        }
      },
      changePassword: (input) => request<void>("POST", "/auth/password", { body: input }),
    },

    setup: {
      status: () => request<{ setupRequired: boolean }>("GET", "/setup", { authenticated: false }),
      async createOwner({ setupSecret, ...input }) {
        // The setup secret travels in a header, never in the JSON body.
        const response = await fetch(`${origin}${PREFIX}/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(setupSecret ? { "x-setup-secret": setupSecret } : {}) },
          body: JSON.stringify(input),
          credentials: "include",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) throw await toError(response);
      },
    },

    dashboard: {
      get: () => request<Dashboard>("GET", "/management/dashboard"),
    },

    reservations: {
      list: async () => (await request<{ reservations: Reservation[] }>("GET", "/management/reservations")).reservations,
      create: async (input) => (await request<{ reservation: Reservation }>("POST", "/management/reservations", { body: input })).reservation,
      updateStatus: (id, status) => request<void>("PATCH", `/management/reservations/${encodeURIComponent(id)}`, { body: { status } }),
      recordPayment: async (id, input) =>
        (
          await request<{ payment: { paymentStatus: "pending" | "settled" } }>("POST", `/management/reservations/${encodeURIComponent(id)}/payments`, {
            body: input,
            idempotencyKey: input.idempotencyKey,
          })
        ).payment,
    },

    payments: {
      list: async () => (await request<{ payments: PaymentRecord[] }>("GET", "/management/payments")).payments,
      confirm: (id, source) => request<void>("PATCH", `/management/payments/${encodeURIComponent(id)}`, { body: { source } }),
    },

    rooms: {
      list: async () => (await request<{ rooms: Room[] }>("GET", "/management/rooms")).rooms,
      create: async (input) => (await request<{ room: Room }>("POST", "/management/rooms", { body: input })).room,
      updateStatus: (id, status) => request<void>("PATCH", `/management/rooms/${encodeURIComponent(id)}`, { body: { status } }),
    },

    staff: {
      list: async () => (await request<{ staff: Staff[] }>("GET", "/management/staff")).staff,
      create: async (input) => (await request<{ staff: Staff }>("POST", "/management/staff", { body: input })).staff,
      updateStatus: (id, employmentStatus) => request<void>("PATCH", `/management/staff/${encodeURIComponent(id)}`, { body: { employmentStatus } }),
    },

    attendance: {
      self: () => request<{ clockedIn: boolean }>("GET", "/management/attendance/self"),
      record: (eventType) => request<void>("POST", "/management/attendance", { body: { eventType } }),
    },

    inventory: {
      list: async () => (await request<{ items: InventoryItem[] }>("GET", "/management/inventory")).items,
      createItem: async (input) => (await request<{ item: InventoryItem }>("POST", "/management/inventory", { body: input })).item,
      recordMovement: (input) => request<void>("POST", "/management/inventory", { body: input }),
    },

    menu: {
      list: async () => (await request<{ menu: MenuItem[] }>("GET", "/management/menu")).menu,
      create: async (input) => (await request<{ item: MenuItem }>("POST", "/management/menu", { body: input })).item,
    },

    pos: {
      overview: () => request<{ shift: Shift | null; orders: PosOrder[] }>("GET", "/management/pos"),
      createOrder: async (input) =>
        (await request<{ order: CreatedPosOrder }>("POST", "/management/pos", { body: input, idempotencyKey: input.idempotencyKey })).order,
      receipt: async (orderId) => (await request<{ receipt: Receipt }>("GET", `/management/pos/${encodeURIComponent(orderId)}`)).receipt,
      openShift: (openingFloatKobo) => request<void>("POST", "/management/pos/shift", { body: { action: "open", openingFloatKobo } }),
      closeShift: async (countedCashKobo) =>
        (await request<{ shift: { varianceKobo: string } }>("POST", "/management/pos/shift", { body: { action: "close", countedCashKobo } })).shift,
    },
  };
}

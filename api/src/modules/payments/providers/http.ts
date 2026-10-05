import { ProviderError } from "./types.js";

type RequestOptions = {
  method?: "GET" | "POST";
  secretKey: string;
  body?: unknown;
  timeoutMs: number;
  /** Retries for idempotent reads only. Writes are never retried automatically. */
  retries?: number;
};

export type ProviderResponse = { status: number; body: Record<string, unknown> | null };

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * JSON call to a payment provider over HTTPS with a hard timeout, a response
 * size cap and bounded retries. The secret key travels only in the
 * Authorization header and never appears in errors or logs.
 */
export async function providerRequest(url: string, options: RequestOptions): Promise<ProviderResponse> {
  const attempts = 1 + (options.method === "POST" ? 0 : (options.retries ?? 2));
  let lastError: ProviderError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${options.secretKey}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new ProviderError("Provider response too large", false);
      let body: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = text ? JSON.parse(text) : null;
        body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      if (response.status === 429 || response.status >= 500) throw new ProviderError(`Provider responded ${response.status}`, true);
      return { status: response.status, body };
    } catch (error) {
      lastError = error instanceof ProviderError ? error : new ProviderError("Provider unreachable", true);
      if (!lastError.retryable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError ?? new ProviderError("Provider unreachable", true);
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

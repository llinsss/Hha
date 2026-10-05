import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const PAYSTACK_TEST_SECRET = "sk_test_a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

type Transaction = { id: number; reference: string; amount: number; currency: string; status: "pending" | "success" | "failed"; createdAt: string };

/**
 * In-process stand-in for the Paystack REST API: initialize, verify and list
 * transactions, with switches for failure modes. Requests must carry the
 * secret key, like the real API.
 */
export class FakePaystack {
  readonly transactions = new Map<string, Transaction>();
  failInitialize = false;
  failVerify = false;
  private server: Server | null = null;
  baseUrl = "";
  private nextId = 1000;

  async start(port = 0): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Marks a checkout as paid on the provider side (optionally with a different amount/currency). */
  succeed(reference: string, overrides: Partial<Pick<Transaction, "amount" | "currency">> = {}): Transaction {
    const transaction = this.transactions.get(reference);
    if (!transaction) throw new Error(`no fake transaction ${reference}`);
    Object.assign(transaction, { status: "success" }, overrides);
    return transaction;
  }

  /** A signed charge.success webhook as Paystack would send it. */
  webhook(reference: string, event = "charge.success"): { body: string; signature: string } {
    const transaction = this.transactions.get(reference);
    const body = JSON.stringify({
      event,
      data: { id: transaction?.id ?? 1, reference, status: "success", amount: transaction?.amount ?? 0, currency: "NGN", customer: { email: "guest@example.com" } },
    });
    return { body, signature: createHmac("sha512", PAYSTACK_TEST_SECRET).update(body).digest("hex") };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? "/", "http://fake");
    // Test-only control surface (used by end-to-end scripts): simulate the guest paying.
    const control = /^\/__control\/(succeed|webhook)\/(.+)$/.exec(url.pathname);
    if (control) {
      const reference = decodeURIComponent(control[2] ?? "");
      if (control[1] === "succeed") return send(200, this.succeed(reference));
      return send(200, this.webhook(reference));
    }
    if (request.headers.authorization !== `Bearer ${PAYSTACK_TEST_SECRET}`) return send(401, { status: false, message: "Invalid key" });
    let raw = "";
    for await (const chunk of request) raw += String(chunk);

    if (request.method === "POST" && url.pathname === "/transaction/initialize") {
      if (this.failInitialize) return send(400, { status: false, message: "Initialization failed" });
      const body = JSON.parse(raw) as { reference: string; amount: number; currency: string };
      this.transactions.set(body.reference, { id: this.nextId++, reference: body.reference, amount: body.amount, currency: body.currency, status: "pending", createdAt: new Date().toISOString() });
      return send(200, { status: true, data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, reference: body.reference } });
    }
    const verify = /^\/transaction\/verify\/(.+)$/.exec(url.pathname);
    if (request.method === "GET" && verify) {
      if (this.failVerify) return send(503, { status: false, message: "Unavailable" });
      const transaction = this.transactions.get(decodeURIComponent(verify[1] ?? ""));
      if (!transaction) return send(404, { status: false, message: "Transaction reference not found" });
      return send(200, { status: true, data: { ...transaction, created_at: transaction.createdAt } });
    }
    if (request.method === "GET" && url.pathname === "/transaction") {
      const data = [...this.transactions.values()].filter((transaction) => transaction.status === "success");
      return send(200, { status: true, data, meta: { pageCount: 1 } });
    }
    return send(404, { status: false, message: "Not found" });
  }
}

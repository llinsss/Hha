import { expect, test, type Page } from "@playwright/test";
import { dialog, lagosDate, openSection, signIn } from "../support/app.js";
import { query } from "../support/database.js";
import { OWNER, PAYSTACK_URL } from "../support/env.js";

/** Books through /reserve and returns the reference from the hosted-checkout redirect. */
async function bookOnline(page: Page, guest: string, arrivalInDays: number): Promise<string> {
  // The provider's hosted checkout page is outside the test; stand in for it.
  await page.route("https://checkout.paystack.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Paystack test checkout</h1>" }));
  await page.goto("/reserve");
  await expect(page.locator(".public-header")).toContainText("Houzz Hills Kaduna");
  await page.getByLabel("Check in").fill(lagosDate(arrivalInDays));
  await page.getByLabel("Check out").fill(lagosDate(arrivalInDays + 2));
  await page.getByLabel("Guests").fill("2");
  await page.getByRole("button", { name: "Check availability" }).click();
  const suite = page.locator(".room-option", { hasText: "Executive Suite" });
  await expect(suite).toContainText("₦150,000");
  await suite.getByRole("button", { name: "Select" }).click();
  await page.getByLabel("Full name").fill(guest);
  await page.getByLabel("Email (for your receipt)").fill("guest@example.com");
  await page.getByRole("button", { name: /Continue to secure payment/ }).click();
  await expect(page.getByRole("heading", { name: "Paystack test checkout" })).toBeVisible();
  const reference = decodeURIComponent(new URL(page.url()).pathname.slice(1));
  expect(reference).toMatch(/^HH-[A-Z0-9]+-[0-9A-F]{32}$/);
  return reference;
}

/** The guest pays on Paystack, which then calls our webhook through the web origin. */
async function payAndNotify(page: Page, reference: string): Promise<void> {
  await page.request.get(`${PAYSTACK_URL}/__control/succeed/${reference}`);
  const { body, signature } = (await (await page.request.get(`${PAYSTACK_URL}/__control/webhook/${reference}`)).json()) as { body: string; signature: string };
  const response = await page.request.post("/api/v1/webhooks/payments", { headers: { "content-type": "application/json", "x-paystack-signature": signature }, data: body });
  expect(response.status()).toBe(200);
}

test.describe("public booking with hosted checkout", () => {
  test("a guest books, pays on Paystack and sees the confirmation", async ({ page }) => {
    const reference = await bookOnline(page, "Web Guest", 10);
    await page.goto(`/payment-result?reference=${encodeURIComponent(reference)}`);
    await expect(page.getByRole("heading", { name: "Confirming your payment…" })).toBeVisible();
    await payAndNotify(page, reference);
    await expect(page.getByRole("heading", { name: "Your stay is confirmed" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(reference)).toBeVisible();

    await signIn(page, OWNER.email, OWNER.password);
    await openSection(page, "Payments");
    await expect(page.getByRole("row", { name: new RegExp(reference) })).toContainText("Online checkout");
  });

  test("a payment after the hold lapsed becomes an exception the owner resolves", async ({ page }) => {
    const reference = await bookOnline(page, "Late Guest", 30);
    // The guest takes longer than the hold allows.
    await query("UPDATE reservations SET hold_expires_at = now() - interval '1 minute' WHERE reference = $1", [reference]);
    await payAndNotify(page, reference);
    await page.goto(`/payment-result?reference=${encodeURIComponent(reference)}`);
    await expect(page.getByRole("heading", { name: "Booking not completed" })).toBeVisible();
    await expect(page.getByText("Your payment arrived after the room hold ended")).toBeVisible();

    await signIn(page, OWNER.email, OWNER.password);
    await expect(page.getByText(/1 payment exception/)).toBeVisible();
    await openSection(page, "Payments");
    const exception = page.getByRole("row", { name: new RegExp(reference) }).filter({ hasText: "Paid after the hold expired" });
    await exception.getByRole("button", { name: "Resolve" }).click();
    await dialog(page).getByLabel(/What was done/).fill("Called the guest and moved them to room 201");
    await dialog(page).getByRole("button", { name: "Mark resolved" }).click();
    await expect(page.getByRole("status")).toHaveText(/Exception resolved/);
    await page.getByRole("button", { name: "Resolved", exact: true }).click();
    await expect(page.getByText("Called the guest and moved them to room 201")).toBeVisible();
  });
});

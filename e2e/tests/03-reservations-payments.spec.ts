import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { answerNextDialog, dialog, lagosDate, openSection, signIn } from "../support/app.js";
import { OWNER } from "../support/env.js";

test.describe("reservations and the payment register", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await openSection(page, "Reservations");
  });

  const book = async (page: import("@playwright/test").Page, guest: string, room: string, checkIn: string, checkOut: string) => {
    await page.getByRole("button", { name: "New reservation" }).click();
    const form = dialog(page);
    await form.getByLabel("Guest full name").fill(guest);
    await form.getByLabel("Email").fill(`${guest.split(" ")[0]!.toLowerCase()}@example.com`);
    const option = form.getByLabel("Room").locator("option", { hasText: new RegExp(`^${room} ·`) });
    await form.getByLabel("Room").selectOption((await option.getAttribute("value")) ?? "");
    await form.getByLabel("Check in").fill(checkIn);
    await form.getByLabel("Check out").fill(checkOut);
    await form.getByRole("button", { name: "Save changes" }).click();
  };

  test("staff booking, overlap rejection, transfer payment and owner confirmation", async ({ page }) => {
    await book(page, "Grace Guest", "101", lagosDate(0), lagosDate(2));
    await expect(page.getByRole("status")).toHaveText(/Reservation HH-.* created/);
    const row = page.getByRole("row", { name: /Grace Guest/ });
    await expect(row).toContainText("₦90,000");
    await expect(row).toContainText("Unpaid");

    // The API rejects an overlapping stay in the same room.
    await book(page, "Clash Guest", "101", lagosDate(1), lagosDate(3));
    await expect(dialog(page).getByText("The room is not available for those dates")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel" }).click();

    await row.getByRole("button", { name: "Record payment" }).click();
    await dialog(page).getByLabel("Amount received (₦)").fill("90000");
    await dialog(page).getByLabel("Payment method").selectOption({ label: "Bank transfer" });
    await dialog(page).getByLabel("Bank transfer reference or sender name").fill("GTB 0042 Grace");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText(/Transfer awaiting confirmation/);
    await expect(row).toContainText("Pending confirmation");

    await openSection(page, "Payments");
    await expect(page.locator(".payment-summary-grid")).toContainText("₦90,000");
    const payment = page.getByRole("row", { name: /GTB 0042 Grace/ });
    await expect(payment).toContainText("pending confirmation");
    answerNextDialog(page, "Seen in GTB statement");
    await payment.getByRole("button", { name: "Confirm transfer" }).click();
    await expect(page.getByRole("status")).toHaveText(/Bank transfer confirmed/);
    await expect(payment).toContainText("settled");
    await expect(payment).toContainText(`Confirmed by ${OWNER.name}`);

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^payments-\d{8}\.csv$/);
    const csv = readFileSync((await file.path())!, "utf8");
    expect(csv.split("\r\n")[0]).toBe("source,reference,guest,unit,amount_kobo,method,status,payment_reference,created_at,recorded_by,confirmed_by,confirmed_at");
    expect(csv).toContain("GTB 0042 Grace");
  });

  test("check-in and check-out follow the API's allowed actions; cancellation needs a reason", async ({ page }) => {
    const row = page.getByRole("row", { name: /Grace Guest/ });
    await expect(row).toContainText("Paid");
    await row.getByRole("combobox").selectOption({ label: "Checked in" });
    await expect(row).toContainText("Checked in");
    await openSection(page, "Rooms");
    await expect(page.getByRole("row", { name: /^101/ })).toContainText("Grace Guest");
    // A room with a guest checked in cannot be marked vacant or inspected: only service states are offered.
    await expect(page.getByRole("combobox", { name: "Update room 101" }).locator("option")).toHaveText(["Set status", "Maintenance", "Out of order"]);

    await openSection(page, "Reservations");
    await row.getByRole("button", { name: "Check out" }).click();
    await expect(row).toContainText("Checked out");

    await page.getByRole("button", { name: "New reservation" }).click();
    await dialog(page).getByLabel("Guest full name").fill("Later Guest");
    await dialog(page).getByLabel("Room").selectOption({ index: 1 });
    await dialog(page).getByLabel("Check in").fill(lagosDate(20));
    await dialog(page).getByLabel("Check out").fill(lagosDate(22));
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    const later = page.getByRole("row", { name: /Later Guest/ });
    // Arrival is in the future, so check-in is not offered yet.
    await expect(later.getByRole("combobox").locator("option")).toHaveText(["Stay action", "Cancelled"]);
    answerNextDialog(page, "Guest changed plans");
    await later.getByRole("combobox").selectOption({ label: "Cancelled" });
    await expect(later).toContainText("Cancelled");

    await page.getByLabel("Search reservations").fill("Later");
    await expect(page.getByRole("row", { name: /Grace Guest/ })).toHaveCount(0);
    await expect(page.getByText("Matching “Later”")).toBeVisible();
  });
});

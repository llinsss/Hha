import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { dialog, openSection, signIn } from "../support/app.js";
import { OWNER, PAYSTACK_KEY } from "../support/env.js";
import { STAFF_FILE } from "../support/staff.js";

test.describe("owner configures the property", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("settings: enable Paystack with an encrypted, write-only key", async ({ page }) => {
    await openSection(page, "Settings");
    // Provider choices and labels come from the API.
    await expect(page.getByRole("radio", { name: "Off (no online payment)" })).toBeChecked();
    await page.getByRole("radio", { name: "Paystack" }).check();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Add the Paystack secret key before enabling Paystack")).toBeVisible();

    await page.getByLabel("Paystack secret key").fill(PAYSTACK_KEY);
    await page.getByLabel("Checkout hold (minutes)").fill("15");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("status")).toHaveText(/Settings saved/);
    await expect(page.getByText(`Saved ••••${PAYSTACK_KEY.slice(-4)}`)).toBeVisible();
    await expect(page.getByLabel("Paystack secret key")).toHaveValue("");
    await expect(page.getByText("/api/v1/webhooks/payments")).toBeVisible();

    await page.getByRole("button", { name: "Check saved key with Paystack" }).click();
    await expect(page.getByText("Paystack accepted the saved key.")).toBeVisible();

    // Persisted on the server: a reload shows the same state.
    await page.reload();
    await openSection(page, "Settings");
    await expect(page.getByRole("radio", { name: "Paystack" })).toBeChecked();
    await expect(page.getByLabel("Checkout hold (minutes)")).toHaveValue("15");
  });

  test("rooms: add rooms, change readiness and see history", async ({ page }) => {
    await openSection(page, "Rooms");
    for (const room of [
      { number: "101", type: "Studio", rate: "45000", capacity: "2" },
      { number: "201", type: "Executive Suite", rate: "75000", capacity: "3" },
      { number: "202", type: "Executive Suite", rate: "75000", capacity: "3" },
    ]) {
      await page.getByRole("button", { name: "Add room" }).click();
      await dialog(page).getByLabel("Room number").fill(room.number);
      await dialog(page).getByLabel("Room category").fill(room.type);
      await dialog(page).getByLabel("Nightly rate (₦)").fill(room.rate);
      await dialog(page).getByLabel("Guest capacity").fill(room.capacity);
      await dialog(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("cell", { name: room.number, exact: true })).toBeVisible();
    }
    await expect(page.getByText("3 rooms")).toBeVisible();

    // The allowed next states come from the API's transition rules.
    const update = page.getByRole("combobox", { name: "Update room 101" });
    await expect(update.locator("option")).toHaveText(["Set status", "Vacant · dirty", "Inspected", "Maintenance", "Out of order"]);
    await update.selectOption("vacant_dirty");
    await expect(page.getByRole("status")).toHaveText(/Room 101 updated/);
    await page.getByRole("combobox", { name: "Update room 101" }).selectOption("inspected");
    await page.getByRole("button", { name: "History for room 101" }).click();
    await expect(dialog(page).getByText("Vacant · dirty → Inspected")).toBeVisible();
    await expect(dialog(page).getByText("Vacant · clean → Vacant · dirty")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Close" }).first().click();

    // Duplicate room numbers are rejected by the API.
    await page.getByRole("button", { name: "Add room" }).click();
    await dialog(page).getByLabel("Room number").fill("101");
    await dialog(page).getByLabel("Room category").fill("Studio");
    await dialog(page).getByLabel("Nightly rate (₦)").fill("1");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(dialog(page).getByText("A record with these details already exists")).toBeVisible();
  });

  test("team: onboard staff with a one-time password", async ({ page }) => {
    await openSection(page, "Team & attendance");
    const onboard = async (person: { name: string; email: string; number: string; department: string; title: string; role: string; password?: string }) => {
      await page.getByRole("button", { name: "Onboard staff" }).click();
      const form = dialog(page);
      await form.getByLabel("Full name").fill(person.name);
      await form.getByLabel("Work email").fill(person.email);
      await form.getByLabel("Employee number").fill(person.number);
      await form.getByLabel("Department").fill(person.department);
      await form.getByLabel("Job title").fill(person.title);
      await form.getByLabel("Role").selectOption({ label: person.role });
      if (person.password) await form.getByLabel(/Temporary password/).fill(person.password);
      await form.getByRole("button", { name: "Save changes" }).click();
    };

    await onboard({ name: "Hauwa Musa", email: "desk@houzzhills.e2e", number: "HH-014", department: "Front desk", title: "Front Desk Officer", role: "Front desk" });
    await expect(dialog(page).getByRole("heading", { name: "Temporary password" })).toBeVisible();
    const generated = (await dialog(page).locator("code").textContent()) ?? "";
    expect(generated).toMatch(/^[A-Za-z0-9_-]{24}$/);
    await dialog(page).getByRole("button", { name: "Close" }).last().click();

    await onboard({ name: "Grace Danjuma", email: "housekeeping@houzzhills.e2e", number: "HH-022", department: "Housekeeping", title: "Room Attendant", role: "Housekeeping", password: "housekeeping pass 1" });
    await onboard({ name: "Tunde Okafor", email: "manager@houzzhills.e2e", number: "HH-002", department: "Management", title: "General Manager", role: "Manager", password: "manager temp pass 1" });
    await expect(page.getByText("3 team members")).toBeVisible();
    writeFileSync(STAFF_FILE, JSON.stringify({ frontDeskPassword: generated }));
  });

  test("inventory and menu: stock ledger and a recipe", async ({ page }) => {
    await openSection(page, "Inventory");
    await page.getByRole("button", { name: "Add item" }).click();
    await dialog(page).getByLabel("Item name").fill("Eggs");
    await dialog(page).getByLabel("Unit", { exact: true }).fill("piece");
    await dialog(page).getByLabel("Opening quantity").fill("10");
    await dialog(page).getByLabel("Reorder at").fill("4");
    await dialog(page).getByLabel("Unit cost (₦)").fill("150");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("row", { name: /Eggs/ })).toContainText("10 piece");

    await page.getByRole("button", { name: "Record movement" }).click();
    await dialog(page).getByLabel("Movement").selectOption({ label: "Receive stock" });
    await dialog(page).getByLabel("Quantity").fill("2");
    await dialog(page).getByLabel("Reason / supplier reference").fill("Market delivery");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("row", { name: /Eggs/ })).toContainText("12 piece");

    await page.getByRole("button", { name: "Record movement" }).click();
    await dialog(page).getByLabel("Movement").selectOption({ label: "Record wastage" });
    await dialog(page).getByLabel("Quantity").fill("50");
    await dialog(page).getByLabel("Reason / supplier reference").fill("Broken");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(dialog(page).getByText("Not enough stock for this movement")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel" }).click();

    await openSection(page, "Restaurant POS");
    await page.getByRole("button", { name: "Menu item" }).click();
    await dialog(page).getByLabel("Item name").fill("Full breakfast");
    await dialog(page).getByLabel("Category").fill("Breakfast");
    await dialog(page).getByLabel("Price (₦)").fill("6500");
    await dialog(page).getByLabel("Inventory item").selectOption({ label: "Eggs · piece" });
    await dialog(page).getByLabel("Quantity per order").fill("2");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".pos-menu-item", { hasText: "Full breakfast" })).toBeVisible();
  });

  test("POS: shift, sale with stock deduction, receipt, edit and close", async ({ page }) => {
    await openSection(page, "Restaurant POS");
    await page.getByRole("button", { name: "Open shift" }).click();
    await dialog(page).getByLabel("Opening cash float (₦)").fill("10000");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Shift open since/)).toBeVisible();

    const breakfast = page.locator(".pos-menu-item", { hasText: "Full breakfast" });
    await breakfast.click();
    await breakfast.click();
    await expect(page.locator(".pos-total strong")).toHaveText(/13,000/);
    await page.getByRole("button", { name: "Take payment & issue receipt" }).click();
    await expect(dialog(page).getByRole("heading", { name: "Restaurant receipt" })).toBeVisible();
    await expect(dialog(page)).toContainText("2 × Full breakfast");
    await expect(dialog(page)).toContainText("CASH");
    await dialog(page).getByRole("button", { name: "Close" }).last().click();
    await expect(page.getByRole("row", { name: /R-\d{8}-/ })).toHaveCount(1);

    await page.getByRole("button", { name: "Edit Full breakfast" }).click();
    await dialog(page).getByLabel("Price (₦)").fill("7000");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(breakfast).toContainText("7,000");

    await openSection(page, "Inventory");
    await expect(page.getByRole("row", { name: /Eggs/ })).toContainText("8 piece");

    await openSection(page, "Restaurant POS");
    await page.getByRole("button", { name: "Close cashier shift" }).click();
    await dialog(page).getByLabel("Counted cash at handover (₦)").fill("23000");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText(/cash variance ₦0/);
    await expect(page.getByText("No active shift")).toBeVisible();
  });
});

import { expect, test } from "@playwright/test";
import { dialog, openSection, signIn } from "../support/app.js";
import { readStaffState } from "../support/staff.js";

const nav = (page: import("@playwright/test").Page) => page.getByRole("navigation").first().getByRole("button");

test.describe("staff sign-in and role limits", () => {
  test("front desk: forced password change, limited menu, clock in", async ({ page }) => {
    await signIn(page, "desk@houzzhills.e2e", readStaffState().frontDeskPassword);
    await expect(dialog(page).getByRole("heading", { name: "Choose your own password" })).toBeVisible();
    await dialog(page).getByLabel("Current password").fill(readStaffState().frontDeskPassword);
    await dialog(page).getByLabel("New password").fill("front desk password 1");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByRole("heading", { level: 1, name: /Good (morning|afternoon|evening), Hauwa/ })).toBeVisible();
    await expect(nav(page)).toHaveText(["Overview", "Reservations", "Rooms"]);
    // Revenue is withheld by the API for this role, so the card is absent.
    await expect(page.getByText("Revenue today")).toHaveCount(0);
    await page.getByRole("button", { name: "Clock in" }).click();
    await expect(page.getByRole("status")).toHaveText(/You are clocked in/);
    await expect(page.getByRole("button", { name: "Clock out" })).toBeVisible();
  });

  test("housekeeping: rooms only, no rates, cleaning states only", async ({ page }) => {
    await signIn(page, "housekeeping@houzzhills.e2e", "housekeeping pass 1");
    await dialog(page).getByLabel("Current password").fill("housekeeping pass 1");
    await dialog(page).getByLabel("New password").fill("housekeeping password 2");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(nav(page)).toHaveText(["Rooms"]);
    await expect(page.getByRole("columnheader", { name: "RATE / NIGHT" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add room" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Update room 101" }).locator("option")).toHaveText(["Set status", "Vacant · clean", "Inspected"]);
    await page.getByRole("combobox", { name: "Update room 101" }).selectOption({ label: "Vacant · clean" });
    await expect(page.getByRole("status")).toHaveText(/Room 101 updated/);
  });

  test("manager: no Settings, cannot assign owner-managed roles", async ({ page }) => {
    await signIn(page, "manager@houzzhills.e2e", "manager temp pass 1");
    await dialog(page).getByLabel("Current password").fill("manager temp pass 1");
    await dialog(page).getByLabel("New password").fill("manager password 22");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(nav(page).filter({ hasText: "Payments" })).toHaveCount(1);
    await expect(nav(page).filter({ hasText: "Settings" })).toHaveCount(0);
    await openSection(page, "Team & attendance");
    await page.getByRole("button", { name: "Onboard staff" }).click();
    const roles = await dialog(page).getByLabel("Role").locator("option").allTextContents();
    expect(roles).not.toContain("Finance");
    expect(roles).not.toContain("Manager");
    expect(roles).toContain("Front desk");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    // The manager cannot manage their own account or the owner-managed ones.
    await expect(page.getByRole("row", { name: /Tunde Okafor/ }).getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("row", { name: /Grace Danjuma/ }).getByRole("combobox")).toHaveCount(1);
  });
});

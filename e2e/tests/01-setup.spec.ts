import { expect, test } from "@playwright/test";
import { signIn } from "../support/app.js";
import { OWNER, SETUP_SECRET } from "../support/env.js";

test.describe("first run", () => {
  test("the sign-in page offers setup while no owner exists", async ({ page }) => {
    await page.goto("/management");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Set up the owner account" })).toBeVisible();
  });

  test("setup rejects a wrong key, then creates the property and owner once", async ({ page }) => {
    await page.goto("/management/setup");
    const fill = async (secret: string) => {
      await page.getByLabel("Setup key").fill(secret);
      await page.getByLabel("Property name").fill("Houzz Hills Kaduna");
      await page.getByLabel("Your full name").fill(OWNER.name);
      await page.getByLabel("Email address").fill(OWNER.email);
      await page.getByLabel("Create a password").fill(OWNER.password);
      await page.getByRole("button", { name: "Create owner account" }).click();
    };
    await fill("not-the-right-setup-key");
    await expect(page.getByText("Setup authorization failed")).toBeVisible();
    await fill(SETUP_SECRET);
    await expect(page.getByRole("heading", { name: "Owner account created" })).toBeVisible();

    // A second attempt is refused by the server.
    await page.goto("/management/setup");
    await fill(SETUP_SECRET);
    await expect(page.getByText("Initial setup is already complete")).toBeVisible();
  });

  test("the owner signs in and sees the property from the API", async ({ page }) => {
    await signIn(page, OWNER.email, "wrong password 123");
    await expect(page.getByText("Email or password is incorrect")).toBeVisible();
    await signIn(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { level: 1, name: /Good (morning|afternoon|evening), Amina/ })).toBeVisible();
    await expect(page.getByText("HOUZZ HILLS KADUNA").first()).toBeVisible();
    // Owner-only section is offered because the API granted settings:manage.
    await expect(page.getByRole("navigation").getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(page.locator(".live-indicator")).toHaveText(/Live/);
  });
});

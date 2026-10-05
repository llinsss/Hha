import { expect, test } from "@playwright/test";
import { openSection, signIn } from "../support/app.js";
import { OWNER } from "../support/env.js";

test("changes made by one user appear for another without reloading", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const managerContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    const manager = await managerContext.newPage();
    await signIn(owner, OWNER.email, OWNER.password);
    await openSection(owner, "Rooms");
    await expect(owner.locator(".live-indicator")).toHaveText(/Live/);

    await signIn(manager, "manager@houzzhills.e2e", "manager password 22");
    await openSection(manager, "Rooms");
    await manager.getByRole("combobox", { name: "Update room 202" }).selectOption({ label: "Maintenance" });
    await expect(manager.getByRole("status")).toHaveText(/Room 202 updated/);

    // The owner's open page refreshes from the event stream.
    await expect(owner.getByRole("row", { name: /^202/ })).toContainText("Maintenance", { timeout: 15_000 });
  } finally {
    await ownerContext.close();
    await managerContext.close();
  }
});

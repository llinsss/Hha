import { expect, type Page } from "@playwright/test";

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/management");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in securely" }).click();
}

/** Opens a workspace section from the sidebar and waits for its heading. */
export async function openSection(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

/** Answers the next window.confirm/prompt the page opens. */
export function answerNextDialog(page: Page, value?: string): void {
  page.once("dialog", (dialog) => void dialog.accept(value));
}

/** The modal dialog currently open. */
export function dialog(page: Page) {
  return page.getByRole("dialog");
}

/** YYYY-MM-DD in Africa/Lagos, offset by whole days (the seeded property's timezone). */
export function lagosDate(days = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
}

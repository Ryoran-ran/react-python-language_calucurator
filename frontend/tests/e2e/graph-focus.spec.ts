import { expect, test } from "@playwright/test";

test("a large search stays readable as a focused route", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/search");
  await expect(page.getByRole("combobox", { name: "探索方針" })).toHaveValue("reach_first");
  await page.getByRole("button", { name: "詳細設定" }).click();
  await page.getByLabel("最大展開数").fill("30");
  await page.getByRole("button", { name: "探索をはじめる" }).click();
  await expect(page.locator(".result-heading")).toContainText("目標に到達", { timeout: 30000 });
  await expect(page.locator(".result-strip")).toContainText("最小コストは保証しません");
  const graph = page.locator(".graph-canvas");
  await expect(graph).toBeVisible();
  await expect(page.locator(".graph-note")).toContainText("語を表示");
  const count = (await graph.getAttribute("aria-label"))?.match(/全(\d+)語のうち(\d+)語/);
  expect(count).not.toBeNull();
  const total = Number(count![1]), shown = Number(count![2]);
  expect(shown).toBeLessThanOrEqual(100);
  expect(shown).toBeLessThanOrEqual(total);
  await page.getByLabel("道筋のみ").check();
  const routeCount = (await graph.getAttribute("aria-label"))?.match(/うち(\d+)語/);
  expect(Number(routeCount?.[1])).toBeLessThanOrEqual(shown);
  expect(errors).toEqual([]);
});

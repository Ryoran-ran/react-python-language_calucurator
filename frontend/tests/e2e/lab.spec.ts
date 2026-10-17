import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { cpus, totalmem, platform } from "node:os";

test("explore, inspect, edit, calculate, project, export and reset", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#/search");
  await expect(
    page.getByRole("heading", { name: "言葉から、言葉への旅。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "探索をはじめる" }).click();
  await expect(page.locator(".result-heading")).toContainText("目標に到達");
  await page.getByRole("button", { name: "ノード一覧" }).click();
  await page
    .locator(".nodes-table")
    .getByRole("button", { name: "犬", exact: true })
    .click();
  await expect(page.locator(".inspected-word h2")).toHaveText("犬");
  const slider = page.getByRole("slider", { name: "タイムラインの位置" });
  await slider.fill("2");
  await expect(page.locator(".nodes-table tbody tr")).toHaveCount(0);
  await page.getByRole("button", { name: "最新へ", exact: true }).click();
  await expect(page.locator(".nodes-table tbody tr").first()).toBeVisible();
  await page.getByRole("button", { name: "探索グラフ", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "../docs/screenshots/search-desktop.png",
    fullPage: true,
  });
  const exportDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  expect((await exportDownload).suggestedFilename()).toBe("kotoba-search.json");
  await page.getByRole("link", { name: "単語パラメータ" }).click();
  await page.getByRole("button", { name: "実験セッションを作る" }).click();
  await page.getByRole("button", { name: "変更をプレビュー" }).click();
  await expect(page.locator(".preview")).toBeVisible();
  await page.getByRole("button", { name: "この変更を確定" }).click();
  await expect(page.locator(".session-label")).toContainText("REV 1");
  await expect(page.getByText("実験で編集済み", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "ベクトル演算" }).click();
  await page.getByRole("button", { name: "計算する", exact: true }).click();
  await expect(page.locator(".arithmetic-answer")).toContainText("北京");
  await page.getByRole("link", { name: "距離比較" }).click();
  await page
    .getByRole("main")
    .getByRole("button", { name: "距離を比較", exact: true })
    .click();
  await expect(page.locator("table.matrix")).toBeVisible();
  await page.getByRole("link", { name: "2D / 3D 可視化" }).click();
  await page
    .getByRole("combobox", { name: "表示次元", exact: true })
    .selectOption("3");
  await page.getByRole("button", { name: "空間を描く" }).click();
  await expect(
    page.getByRole("heading", { name: "PCA · 3D", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".js-plotly-plot")).toBeVisible();
  await page.getByRole("button", { name: "実験を破棄して基底に戻す" }).click();
  await expect(page.locator(".experiment-indicator")).toHaveText("基底モデル");
  await page.goto("/#/search");
  await expect(page.locator(".graph-canvas")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "../docs/screenshots/search-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("arithmetic answer appears immediately below the formula", async ({ page }) => {
  await page.goto("/#/arithmetic");
  await page.getByRole("button", { name: "計算する", exact: true }).click();
  const answer = page.locator(".arithmetic-answer");
  await expect(answer).toBeVisible();
  const firstWord = await answer.locator("strong").innerText();
  const formulaBox = await page.locator(".formula-editor").boundingBox();
  const answerBox = await answer.boundingBox();
  expect(answerBox!.y - (formulaBox!.y + formulaBox!.height)).toBeLessThan(30);
  await page.getByLabel("計算式").fill("[東京] + [中国]");
  await expect(answer).toHaveCount(0);
  await page.getByRole("button", { name: "計算する", exact: true }).click();
  await expect(answer).toBeVisible();
  await page.getByRole("button", { name: /全20件と詳しい数値を見る/ }).click();
  await expect(page.locator(".panel table tbody tr")).toHaveCount(20);
  await expect(page.locator(".panel table tbody .word-link").first()).toHaveText(firstWord);
  await page.getByText("ベクトルの統計を見る").click();
  await expect(page.locator(".arithmetic-stat-details .stats-grid")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
});

test("major screens have no serious accessibility violations", async ({
  page,
}) => {
  for (const route of [
    "search",
    "arithmetic",
    "vectors",
    "distances",
    "projection",
    "models",
  ]) {
    await page.goto("/#/" + route);
    await expect(page.locator("main h1")).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      results.violations
        .filter((v) => ["serious", "critical"].includes(v.impact || ""))
        .map((v) => ({
          route,
          id: v.id,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            reason: n.failureSummary,
          })),
        })),
    ).toEqual([]);
  }
});

test("selects the server default model when the workspace opens", async ({
  page,
}) => {
  const response = await page.request.get("/api/v1/models");
  const catalog = await response.json();
  const defaultModel = catalog.models.find(
    (model: { id: string }) => model.id === catalog.default_model_id,
  );
  await page.goto("/#/arithmetic");
  await expect(
    page.getByRole("combobox", { name: "使用するモデル" }),
  ).toHaveValue(defaultModel.id);
  await expect(
    page.getByRole("combobox", { name: "使用するモデル" }),
  ).toContainText(defaultModel.display_name);
});

test("OOV and invalid arithmetic are explained at input", async ({ page }) => {
  await page.goto("/#/search");
  await page.getByLabel("たどり着きたい言葉").fill("未登録語");
  await page.getByRole("button", { name: "探索をはじめる" }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "モデルに含まれません",
  );
  await page.getByRole("link", { name: "ベクトル演算" }).click();
  await page.getByLabel("計算式").fill("[東京]");
  await page.getByRole("button", { name: "＋を式に挿入" }).click();
  await expect(page.getByLabel("計算式")).toHaveValue("[東京] + ");
  await page.getByLabel("計算式").fill("[猫] × [犬]");
  await expect(page.getByRole("button", { name: "計算する" })).toBeDisabled();
});

test("similarity ranks words in either direction", async ({ page }) => {
  await page.goto("/#/similarity");
  await page.getByRole("button", { name: "遠い言葉", exact: true }).click();
  await expect(page.getByText("最大コサイン類似度")).toBeVisible();
  await page.getByRole("button", { name: "遠い言葉を探す" }).click();
  await expect(page.getByText("遠い言葉ランキング")).toBeVisible();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(20);
  const scores = (
    await rows.locator("td:nth-child(3) .score-cell span").allTextContents()
  ).map(Number);
  expect(scores).toEqual([...scores].sort((a, b) => a - b));
  const exportDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  expect((await exportDownload).suggestedFilename()).toBe("kotoba-similarity.csv");
  await page.getByRole("button", { name: "近い言葉", exact: true }).click();
  await expect(page.getByText("最小コサイン類似度")).toBeVisible();
  await page.getByRole("button", { name: "近い言葉を探す" }).click();
  await expect(page.getByText("近い言葉ランキング")).toBeVisible();
  const nearest = (
    await rows.locator("td:nth-child(3) .score-cell span").allTextContents()
  ).map(Number);
  expect(nearest).toEqual([...nearest].sort((a, b) => b - a));
});

test("recovers complete event history after an interrupted SSE connection", async ({
  page,
}) => {
  let interrupted = false;
  await page.route("**/searches/*/events", async (route) => {
    if (!interrupted) {
      interrupted = true;
      await route.abort();
    } else await route.continue();
  });
  await page.goto("/#/search");
  await page.getByRole("button", { name: "探索をはじめる" }).click();
  await expect(page.locator(".result-heading")).toContainText("目標に到達");
  const key = new URLSearchParams(page.url().split("?")[1]).get("job");
  const response = await page.request.get(`/api/v1/searches/${key}`);
  const search = await response.json();
  await expect(
    page.getByText(`${search.events.length} EVENTS`, { exact: true }),
  ).toBeVisible();
  expect(interrupted).toBe(true);
});

test("pause, step, cancel and keyboard accessible mobile workspace", async ({
  page,
}) => {
  await page.goto("/#/search");
  await page.getByRole("button", { name: "詳細設定" }).click();
  await page.getByLabel("一時停止状態で開始").check();
  await page.getByRole("button", { name: "探索をはじめる" }).click();
  await expect(page.getByRole("button", { name: "探索を再開" })).toBeVisible();
  await page.getByRole("button", { name: "1ステップ", exact: true }).click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.locator(".result-heading")).toContainText("キャンセル");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.getByRole("link", { name: "単語パラメータ" }).click();
  await expect(
    page.getByRole("heading", { name: "言葉を、ひらいてみる。" }),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await expect(page.locator(".js-plotly-plot").first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "../docs/screenshots/vectors-mobile.png",
    fullPage: true,
  });
});

test("5000 nodes keep controls and pan/zoom responsive", async ({ page }) => {
  await page.goto("/tests/benchmark.html");
  await expect(page.locator('span[role="status"]')).toHaveText("ready");
  const renderMs = Number(await page.getByTestId("render-ms").textContent());
  const framePromise = page.evaluate(async () => {
    const frames: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 60; i++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
    }
    return frames;
  });
  const canvas = page.locator(".graph-canvas"),
    bounds = (await canvas.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width / 2 + 150,
    bounds.y + bounds.height / 2 + 70,
    { steps: 12 },
  );
  await page.mouse.up();
  await page.mouse.wheel(0, -180);
  const frames = (await framePromise).sort((a, b) => a - b);
  const responseTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    await page
      .getByRole("button", { name: `応答確認 ${i}`, exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `応答確認 ${i + 1}`, exact: true }),
    ).toBeVisible();
    responseTimes.push(Date.now() - start);
  }
  const record = {
    nodes: 5000,
    edges: 4999,
    platform: platform(),
    cpu: cpus()[0].model,
    ram_gb: totalmem() / 1024 ** 3,
    render_ms: renderMs,
    frame_p95_ms: frames[Math.floor(frames.length * 0.95)],
    interaction_ms: responseTimes,
    note: "Development-only synthetic fixture; Chromium headless; pan, zoom and controls exercised.",
  };
  await writeFile(
    "../docs/performance-5000.json",
    JSON.stringify(record, null, 2),
  );
  expect(record.frame_p95_ms).toBeLessThan(250);
  expect(Math.max(...responseTimes)).toBeLessThan(2000);
});

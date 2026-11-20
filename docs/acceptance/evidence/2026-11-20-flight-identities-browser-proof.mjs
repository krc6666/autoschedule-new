import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer, preview } from "vite";

const output = "docs/acceptance/evidence/2026-11-20-flight-identities-";
const temp = resolve(".tmp/flight-identities/browser-temp");
mkdirSync(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
const production = process.env.FLIGHT_PROOF_BUILD === "1";
const server = production
  ? await preview({
      configFile: false,
      build: { outDir: ".tmp/flight-identities/production" },
      preview: { host: "127.0.0.1", port: 55432, strictPort: true },
    })
  : await createServer({
      server: {
        host: "127.0.0.1",
        port: 55432,
        strictPort: true,
        watch: {
          ignored: [
            "**/.tmp/flight-identities/browser-profile/**",
            "**/.tmp/flight-identities/browser-temp/**",
          ],
        },
      },
    });
let context;
const errors = [];
const report = {
  syntheticOnly: true,
  productionBuild: production,
  origin: "http://127.0.0.1:55432",
  checks: [],
};
try {
  if (!production) await server.listen();
  context = await chromium.launchPersistentContext(
    resolve(".tmp/flight-identities/browser-profile"),
    {
      executablePath:
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
      viewport: { width: 1440, height: 960 },
      acceptDownloads: true,
    }
  );
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.protocol === "data:"
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("browser:", message.text());
  });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("flight-identity-proof")) {
      localStorage.clear();
      sessionStorage.setItem("flight-identity-proof", "1");
    }
  });
  await page.goto(`${report.origin}/.tmp/flight-identities/browser.html`);
  await page
    .waitForFunction(() => window.isolated, { timeout: 15000 })
    .catch(async (error) => {
      console.log(
        JSON.stringify({ errors, body: await page.locator("body").innerText() })
      );
      throw error;
    });
  await page.locator('.app-nav button[title="配置"]').click();
  await page.getByRole("button", { name: "新建航班档案", exact: true }).click();
  await page
    .getByLabel("航班档案统一名称", { exact: true })
    .fill("国泰长期航班");
  for (const name of ["CX937早", "CX937晚", "AB999"]) {
    await page
      .getByRole("button", { name: "添加新旧名称", exact: true })
      .click();
    await page.getByLabel("档案航班名称", { exact: true }).last().fill(name);
  }
  await page
    .getByLabel("沿用岗位版本", { exact: true })
    .last()
    .selectOption("CX937晚");
  await page
    .getByRole("button", { name: "确认并保存航班档案", exact: true })
    .click();
  await page.waitForFunction(() => !window.isolated.mounted.hasUnsavedRules());
  let state = await page.evaluate(() => window.isolated.snapshot());
  const stable = `@${state.shared.flightIdentities[0].id.toUpperCase()}`;
  assert.deepEqual(state.settings.latePriorityFlightNumbers, [stable]);
  assert.equal(
    state.positionRules.find((r) => r.flightNo === "AB999")
      .qualifiedStaffIds[0],
    "test-person"
  );
  assert.equal(state.history[0].flightNo, "CX937早");
  report.checks.push("新建、规则归档案、本组岗位复制及历史原名保留");

  await page
    .getByLabel("航班档案统一名称", { exact: true })
    .fill("国泰统一统计");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator('.app-nav button[title="规则"]').click();
  assert.equal(await page.locator("autoschedule-config-page").count(), 1);
  assert.equal(
    await page.evaluate(
      () => window.isolated.snapshot().shared.flightIdentities[0].displayName
    ),
    "国泰长期航班"
  );
  await page
    .getByRole("button", { name: "确认并保存航班档案", exact: true })
    .click();
  await page.waitForFunction(() => !window.isolated.mounted.hasUnsavedRules());
  assert.equal(
    await page.evaluate(
      () => window.isolated.snapshot().shared.flightIdentities[0].displayName
    ),
    "国泰统一统计"
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${output}desktop.png`, fullPage: true });
  report.checks.push("未保存离开取消保护、再次保存成功");

  await page.locator('.app-nav button[title="规则"]').click();
  await page.locator("input[type=search]").fill("CX937早");
  await page
    .locator('[data-policy-collection="sameFlightStaffExclusions"]')
    .count();
  assert.ok(
    (await page.locator("autoschedule-policy-page").innerText()).includes(
      "同航班"
    )
  );
  assert.ok(
    (await page.locator("autoschedule-policy-page").innerText()).includes(
      "国泰统一统计"
    )
  );
  report.checks.push("按旧航班名搜索共用规则，显示统一名称");
  await page.locator('.app-nav button[title="统计"]').click();
  assert.ok(
    (await page.locator("autoschedule-statistics-page").innerText()).includes(
      "国泰统一统计"
    )
  );
  const countCell = page.locator(
    '.late-priority-statistics .late-priority-count-detail[data-staff-id="test-person"]'
  );
  assert.equal(
    (await countCell.locator(":scope > summary").innerText()).trim(),
    "3"
  );
  await countCell.locator(":scope > summary").click();
  const detail = await countCell
    .locator(".late-priority-detail-list")
    .innerText();
  for (const original of ["CX937早", "CX937晚", "AB999"])
    assert.ok(detail.includes(original), detail);
  report.checks.push("页面统一列显示3次，展开可逐项追溯同日早晚及新号");
  report.statisticsText = await page
    .locator("autoschedule-statistics-page")
    .innerText();
  await page.locator("autoschedule-app-toast .btn-close").click();
  await page.locator(".late-priority-statistics").scrollIntoViewIfNeeded();
  await page
    .locator(".late-priority-statistics")
    .screenshot({ path: `${output}statistics.png` });
  report.roundtrip = await page.evaluate(() => window.isolated.roundtrip());
  assert.deepEqual(report.roundtrip.rules, [stable]);
  assert.deepEqual(report.roundtrip.columns, [stable]);
  assert.equal(report.roundtrip.actualNumberOneCount, 3);
  assert.deepEqual(
    report.roundtrip.originalEvents
      .map((e) => `${e.date}/${e.flightNo}`)
      .sort(),
    ["2026-11-01/CX937早", "2026-11-01/CX937晚", "2026-11-02/AB999"].sort()
  );
  assert.deepEqual(report.roundtrip.role, [
    { name: "H02", qualifiedStaffIds: ["test-person"] },
  ]);
  report.checks.push(
    "配置真实XLSX字节→不同旧值设备导入→完整JSON重启→规则/岗位/统计实际生效"
  );

  await page.reload();
  await page.locator('.app-nav button[title="配置"]').click();
  assert.equal(
    await page.getByLabel("航班档案统一名称", { exact: true }).inputValue(),
    "国泰统一统计"
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${output}mobile.png`, fullPage: true });
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.ok(width.document <= width.viewport + 1, JSON.stringify(width));
  report.checks.push("浏览器持久化重启、桌面及390宽度页面无整页横溢");
  assert.deepEqual(errors, []);
  report.pageErrors = errors;
  report.finalState = await page.evaluate(() => window.isolated.snapshot());
  writeFileSync(`${output}browser.json`, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ checks: report.checks, pageErrors: errors, width })
  );
} finally {
  await context?.close();
  if (production)
    await new Promise((resolve) => server.httpServer.close(resolve));
  else await server.close();
}

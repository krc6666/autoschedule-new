import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import XLSX from "xlsx-js-style";

const origin = "http://127.0.0.1:64781";
const prefix = "docs/acceptance/evidence/2026-11-18-relaxed-";
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  timezoneId: "Asia/Singapore",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort();
  if (url.pathname === "/__relaxed_evidence__")
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/node_modules/bootstrap/dist/css/bootstrap.min.css"><link rel="stylesheet" href="/node_modules/bootstrap-icons/font/bootstrap-icons.min.css"><link rel="stylesheet" href="/src/styles.css"></head><body><div id="app"></div><script type="module">
    import { mountAutoscheduleApp } from '/src/app.ts';
    import { createAutoscheduleStore } from '/src/app/store/autoschedule-store.ts';
    import { browserStatePersistence } from '/src/infrastructure/storage.ts';
    import { relaxedMatrixFixture, matrixHistory } from '/tests/helpers/relaxed-flight-matrix.ts';
    let initialState;
    if (!localStorage.getItem('autoschedule.state.v1')) {
      initialState = relaxedMatrixFixture();
      initialState.history = [matrixHistory(initialState.assignments[0], '2026-11-16'), matrixHistory(initialState.assignments[0], '2026-10-20')];
    }
    window.evidenceStore = createAutoscheduleStore({ persistence: browserStatePersistence, initialState });
    evidenceStore.getState().persist();
    window.evidenceApp = mountAutoscheduleApp(document.querySelector('#app'), { store: evidenceStore });
    window.evidenceReady = true;
  </script></body></html>`,
    });
  return route.continue();
});

const navigate = async () => {
  await page.goto(`${origin}/__relaxed_evidence__`);
  await page.waitForFunction(() => window.evidenceReady);
  await page.locator('.app-nav button[title="统计"]').click();
  await page.locator(".relaxed-shift-table").waitFor();
};
const snapshot = () =>
  page.locator(".relaxed-shift-table").evaluate((table) => ({
    headers: [...table.querySelectorAll("th")].map((c) => c.textContent.trim()),
    rows: [...table.querySelectorAll("tbody tr")].map((row) => ({
      name: row.querySelector("td").textContent.trim(),
      cells: [...row.querySelectorAll("td[data-label]")]
        .slice(1)
        .map((cell) => ({
          column: cell.dataset.label,
          count: Number(cell.querySelector("summary").textContent.trim()),
          dates: cell
            .querySelector(".late-priority-detail-list")
            .textContent.trim(),
        })),
    })),
  }));

try {
  await navigate();
  const original = await snapshot();
  const facts = await page.evaluate(() => {
    const state = window.evidenceStore.getState().model;
    return {
      date: state.activeScheduleDate,
      staff: state.staff.map((p) => ({ id: p.id, name: p.name })),
      assignments: state.assignments,
      history: state.history,
      flights: state.flights,
      afternoonStart: state.settings.afternoonRestStartTime,
      afternoonEnd: state.settings.afternoonRestEndTime,
      earlyCutoff: state.settings.earlyDepartureCutoffTime,
    };
  });
  assert.deepEqual(original.headers, [
    "人员",
    "MF8001",
    "CX937",
    "下午空",
    "下午休",
  ]);
  assert.deepEqual(
    original.rows[0].cells.map((c) => c.count),
    [2, 0, 0, 2]
  );
  assert.deepEqual(
    original.rows[1].cells.map((c) => c.count),
    [0, 1, 1, 0]
  );
  const firstCell = page
    .locator(".relaxed-shift-table tbody tr")
    .first()
    .locator('td[data-label="MF8001"]');
  await firstCell.locator("summary").click();
  assert.equal(await firstCell.locator("details").getAttribute("open"), "");
  assert.equal(
    (await firstCell.locator(".late-priority-detail-list").innerText()).trim(),
    "11-16、11-18"
  );
  await page
    .locator(".relaxed-shift-statistics")
    .screenshot({ path: `${prefix}desktop.png` });
  await page.locator(".relaxed-shift-flight-scope > summary").click();
  await page.getByLabel("轻松班次统计航班：CX937", { exact: true }).uncheck();
  await page.waitForFunction(
    () => document.querySelectorAll(".relaxed-shift-table th").length === 4
  );
  assert.deepEqual((await snapshot()).headers, [
    "人员",
    "MF8001",
    "下午空",
    "下午休",
  ]);
  await navigate();
  assert.deepEqual((await snapshot()).headers, [
    "人员",
    "MF8001",
    "下午空",
    "下午休",
  ]);
  const restored = await snapshot();
  for (const row of restored.rows) {
    const expected = original.rows.find((item) => item.name === row.name);
    assert.deepEqual(
      row.cells,
      expected.cells.filter((cell) => cell.column !== "CX937")
    );
  }
  await page.locator(".relaxed-shift-flight-scope > summary").click();
  await page.getByLabel("轻松班次统计航班：CX937", { exact: true }).check();
  await page.getByLabel("轻松班次统计月份", { exact: true }).fill("2026-10");
  await page
    .getByLabel("轻松班次统计月份", { exact: true })
    .dispatchEvent("change");
  await page.waitForFunction(() =>
    document
      .querySelector(
        '.relaxed-shift-table td[data-label="MF8001"] .late-priority-detail-list'
      )
      .textContent.includes("10-20")
  );
  assert.deepEqual(
    (await snapshot()).rows[0].cells.map((c) => c.count),
    [1, 0, 0, 1]
  );
  assert.equal(
    await page.getByLabel("末班重点岗位统计月份", { exact: true }).inputValue(),
    "2026-11"
  );
  await page.getByLabel("轻松班次统计月份", { exact: true }).fill("2026-11");
  await page
    .getByLabel("轻松班次统计月份", { exact: true })
    .dispatchEvent("change");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".relaxed-shift-statistics").scrollIntoViewIfNeeded();
  const mobile = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    tableWidth: document
      .querySelector(".relaxed-shift-table")
      .getBoundingClientRect().width,
  }));
  assert.ok(mobile.scrollWidth <= mobile.width + 1, JSON.stringify(mobile));
  await page
    .locator(".relaxed-shift-table tbody tr")
    .first()
    .locator('td[data-label="MF8001"] summary')
    .click();
  await page
    .locator(".relaxed-shift-statistics")
    .screenshot({ path: `${prefix}mobile.png` });
  const mobileOpen = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(
    mobileOpen.scrollWidth <= mobileOpen.width + 1,
    JSON.stringify(mobileOpen)
  );
  await page
    .locator(".relaxed-shift-flight-scope button")
    .filter({ hasText: "清空" })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".relaxed-shift-table th").length === 3
  );
  assert.deepEqual((await snapshot()).headers, ["人员", "下午空", "下午休"]);
  await page
    .locator(".relaxed-shift-flight-scope button")
    .filter({ hasText: "全选" })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".relaxed-shift-table th").length > 3
  );
  const allHeaders = (await snapshot()).headers;
  assert.ok(allHeaders.includes("PM1"));
  await page.locator("#active-group").selectOption("B");
  await page.waitForFunction(
    () => document.querySelector("autoschedule-app").model.activeGroupId === "B"
  );
  await page.locator("#active-group").selectOption("A");
  await page.waitForFunction(
    () => document.querySelector("autoschedule-app").model.activeGroupId === "A"
  );
  assert.deepEqual((await snapshot()).headers, allHeaders);
  const final = await snapshot();
  const workbook = await page.evaluate(async () => {
    const { buildConfigWorkbook } =
      await import("/src/infrastructure/excel.ts");
    return buildConfigWorkbook(window.evidenceStore.getState().model);
  });
  writeFileSync(
    `${prefix}config.xlsx`,
    XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })
  );
  await page.evaluate(() =>
    document.querySelector("autoschedule-app").commandHandler.handle({
      type: "assign-staff",
      assignmentId: "task-1",
      staffId: "person-0",
    })
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector("autoschedule-app")
        .model.assignments.find((a) => a.id === "task-1").staffId === "person-0"
  );
  const reassigned = await snapshot();
  assert.equal(
    reassigned.rows[0].cells.find((c) => c.column === "下午空").count,
    1
  );
  assert.equal(
    reassigned.rows[0].cells.find((c) => c.column === "下午休").count,
    1
  );
  await page.evaluate(() =>
    document.querySelector("autoschedule-app").commandHandler.handle({
      type: "assign-staff",
      assignmentId: "task-1",
      staffId: "",
    })
  );
  await page.waitForFunction(
    () =>
      !document
        .querySelector("autoschedule-app")
        .model.assignments.find((a) => a.id === "task-1").staffId
  );
  const cleared = await snapshot();
  assert.equal(
    cleared.rows[0].cells.find((c) => c.column === "下午空").count,
    0
  );
  assert.equal(
    cleared.rows[0].cells.find((c) => c.column === "下午休").count,
    2
  );
  const scopeBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    scopeBook,
    XLSX.utils.aoa_to_sheet([
      ["选择方式", "航班号"],
      ["指定", "MF8001"],
      ["指定", "CX937"],
    ]),
    "轻松班次航班范围"
  );
  await page.locator('autoschedule-app input[type="file"]').setInputFiles({
    name: "anonymous-scope.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: XLSX.write(scopeBook, { type: "buffer", bookType: "xlsx" }),
  });
  await page
    .locator("autoschedule-workbook-import-dialog .modal-footer .btn-primary")
    .waitFor({ state: "visible" });
  await page
    .locator("autoschedule-workbook-import-dialog .modal-footer .btn-primary")
    .click();
  await page.waitForFunction(
    () =>
      JSON.stringify(
        document.querySelector("autoschedule-app").model.settings
          .relaxedShiftFlightNumbers
      ) === JSON.stringify(["MF8001", "CX937"])
  );
  const imported = await snapshot();
  assert.deepEqual(imported.headers, [
    "人员",
    "MF8001",
    "CX937",
    "下午空",
    "下午休",
  ]);
  // Configuration import retains its existing explicit clearing contract.
  assert.equal(
    await page.evaluate(
      () => evidenceStore.getState().model.assignments.length
    ),
    0
  );
  writeFileSync(
    `${prefix}browser.json`,
    JSON.stringify(
      {
        entry:
          "isolated Chrome / mountAutoscheduleApp + original Store/controllers + browser persistence",
        facts,
        original,
        restored,
        mobile,
        mobileOpen,
        final,
        reassigned,
        cleared,
        imported,
        actions: [
          "click count",
          "uncheck and persist",
          "reload and restore all counts/dates",
          "independent month",
          "390px with open dates",
          "clear",
          "select all",
          "A/B/A",
          "real assign-staff command",
          "real clear-assignee command",
          "actual XLSX file upload/preview/confirm (original configuration import clears current schedule)",
        ],
        pageErrors: errors,
      },
      null,
      2
    )
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser assertions passed: dates, selection/reload, month, empty/all, A/B isolation, 1440/390 layout, no page errors."
  );
} catch (error) {
  console.log(
    JSON.stringify({
      pageErrors: errors,
      text: (await page.locator("body").innerText()).slice(0, 1800),
    })
  );
  await page.screenshot({ path: `${prefix}browser-failure.png` });
  throw error;
} finally {
  await browser.close();
}

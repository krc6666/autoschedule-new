import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

// Isolated anonymous fixture, never connects to the owner's browser/profile.
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const result = {
  input: "TR121/H04 old declaration history; edit current remark to combined",
  checks: {},
};
const model = () =>
  page.evaluate(() => document.querySelector("autoschedule-app").model);
async function statistics() {
  await page.locator('nav button[title="统计"]').click();
  await page
    .getByRole("button", { name: "末班重点岗位统计类别：送资料", exact: true })
    .click();
  const late = page
    .locator(".late-priority-summary-table tbody tr")
    .filter({ hasText: "测试人员甲" });
  assert.equal(
    await late.locator('td[data-label="TR121"] summary').innerText(),
    "1"
  );
  assert.equal(
    await page
      .locator(
        '.ordinary-priority-count-detail[data-staff-id="test-a"][data-position="H04"] summary'
      )
      .innerText(),
    "1"
  );
  await page
    .getByRole("button", { name: "末班重点岗位统计类别：申报", exact: true })
    .click();
  assert.equal(await late.count(), 0); // No declaration qualification or records remain.
}
try {
  await page.goto("http://127.0.0.1:5193/", { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { createDefaultState } = await import("/src/defaults.ts");
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (r) => r.flightNo === "TR121" && r.name === "H04"
    );
    const person = {
      ...state.staff[0],
      id: "test-a",
      name: "测试人员甲",
      status: "正常",
      staffType: "常规",
    };
    rule.qualifiedStaffIds = [person.id];
    rule.remark = "申报";
    state.staff = [person];
    state.positionRules = [rule];
    state.flights = state.flights.filter((f) => f.flightNo === "TR121");
    state.flights[0].positions = ["H04"];
    state.templates = state.templates.filter((f) => f.flightNo === "TR121");
    state.templates[0].positions = ["H04"];
    state.shared.templates = state.templates;
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "TR", position: "H04" },
    ];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.assignments = [];
    state.activeScheduleDate = null;
    state.history = [
      {
        id: "old-h04",
        date: "2026-11-03",
        flightNo: "TR121",
        position: "H04",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 7,
        remark: "申报",
        assignmentRemarks: { remark: "申报", manualRemark: "保留原文" },
      },
    ];
    Object.assign(state.groups.A, {
      staff: state.staff,
      positionRules: state.positionRules,
      flights: state.flights,
      settings: state.settings,
      assignments: [],
      activeScheduleDate: null,
      history: state.history,
    });
    localStorage.setItem("autoschedule.state.v1", JSON.stringify(state));
    localStorage.setItem("autoschedule.scheduleDate", "2026-11-03");
  });
  await page.reload({ waitUntil: "networkidle" });
  const before = await model();
  await page.locator('nav button[title="配置"]').click();
  const group = page
    .locator("details.position-rule-group")
    .filter({ hasText: "TR121" });
  await group.locator("summary").click();
  const remark = group.locator('input[aria-label="备注"]');
  await remark.fill("申报/送资料");
  await remark.press("Tab");
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.positionRules.some(
        (r) =>
          r.flightNo === "TR121" &&
          r.name === "H04" &&
          r.remark === "申报/送资料"
      )
  );
  await statistics();
  const after = await model();
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.groups.B, before.groups.B);
  result.checks.actualConfigurationEditTwoTablesAndHistoryPreserved = true;
  await page.reload({ waitUntil: "networkidle" });
  await statistics();
  result.checks.reloadKeepsCounts = true;
  await page.locator('nav button[title="历史"]').click();
  const day = page
    .locator("details.history-day")
    .filter({ hasText: "2026-11-03" });
  await day.locator("summary").click();
  await day.getByRole("button", { name: "编辑该日排班", exact: true }).click();
  await page.locator(".schedule-name-input").waitFor();
  assert.equal(
    (await model()).assignments.find((a) => a.position === "H04").remark,
    "申报"
  );
  result.checks.historicalDraftRetainsOldRemark = true;
  page.once("dialog", (d) => d.accept());
  await page
    .locator(".schedule-toolbar button")
    .filter({ hasText: "保存并更新历史" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("autoschedule-app").view.historyEditDate === null
  );
  await statistics();
  assert.equal(
    (await model()).history.find((r) => r.position === "H04").assignmentRemarks
      .remark,
    "申报"
  );
  result.checks.historyEditSaveKeepsCountsAndSource = true;
  await page
    .getByRole("button", { name: "末班重点岗位统计类别：送资料", exact: true })
    .click();
  const downloadPromise = page
    .waitForEvent("download")
    .catch((e) => ({ error: e.message }));
  await page.locator('button[title="导出当前月份末班重点岗位次数"]').click();
  const download = await downloadPromise;
  if (download.error)
    throw new Error(
      JSON.stringify({
        download: download.error,
        errors,
        body: await page.locator("body").innerText(),
      })
    );
  const downloadPath = await download.path();
  const xlsx = await import("xlsx-js-style");
  const XLSX = xlsx.default;
  const workbook = XLSX.readFile(downloadPath);
  const exported = XLSX.utils.sheet_to_json(
    workbook.Sheets[workbook.SheetNames[0]]
  );
  assert.equal(exported.find((r) => r["岗位类别"] === "送资料")["最终次数"], 1);
  assert.equal(
    exported.some((r) => r["岗位类别"] === "申报"),
    false
  );
  result.checks.actualExportDeliveryOneNoDeclaration = true;
  // Independent expected count: one anonymous person/date/flight H04 record, combined => delivery only.
  const source = (await model()).history.filter(
    (r) =>
      r.date === "2026-11-03" &&
      r.flightNo === "TR121" &&
      r.position === "H04" &&
      r.staffId === "test-a"
  );
  assert.equal(source.length, 1);
  result.independentExpected = { delivery: 1, declaration: 0, ordinaryH04: 1 };
  await page.screenshot({
    path: "docs/acceptance/evidence/2026-11-03-remark-counts-page.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await statistics();
  result.checks.mobileTwoTables = true;
  assert.deepEqual(errors, []);
  result.pageErrors = errors;
  writeFileSync(
    "docs/acceptance/evidence/2026-11-03-remark-counts-browser.txt",
    JSON.stringify(result, null, 2) + "\n"
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(
    JSON.stringify(
      await page.evaluate(() => ({
        date: document.querySelector("autoschedule-app").view.scheduleDate,
        staff: document
          .querySelector("autoschedule-app")
          .model.staff.map((p) => [p.id, p.name]),
        history: document.querySelector("autoschedule-app").model.history,
        months: [...document.querySelectorAll("input[type=month]")].map(
          (e) => e.value
        ),
      }))
    )
  );
  throw error;
} finally {
  await browser.close();
}

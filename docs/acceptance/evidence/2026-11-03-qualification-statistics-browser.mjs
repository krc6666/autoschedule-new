import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = {
  input:
    "Anonymous unqualified TR121/H05 and morning position, past 11/01 plus current 11/03",
  checks: {},
};
try {
  await page.goto("http://127.0.0.1:5193/", { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { createDefaultState } = await import("/src/defaults.ts");
    const { makeUnfilled } =
      await import("/src/domain/flights/schedule-position-rules.ts");
    const { scheduleRuleFingerprint } =
      await import("/src/domain/rules/schedule-rule-fingerprint.ts");
    const state = createDefaultState();
    state.staff = state.staff
      .slice(0, 2)
      .map((p, i) => ({
        ...p,
        id: `probe-${i}`,
        name: i ? "测试早班人员" : "测试送资料人员",
        status: "正常",
        staffType: "常规",
        nightShift: true,
        dutyQualified: false,
        cxPreflightQualified: false,
        standbyQualified: false,
        teamLeader: false,
      }));
    const late = state.positionRules.find(
      (r) => r.flightNo === "TR121" && r.name === "H05"
    );
    late.qualifiedStaffIds = [];
    const morning = {
      ...late,
      id: "probe-rule",
      flightNo: "TEST100",
      name: "G01",
      remark: "",
      qualifiedStaffIds: [],
    };
    state.positionRules = [late, morning];
    const flight = state.flights.find((f) => f.flightNo === "TR121");
    flight.positions = ["H05"];
    state.flights = [
      flight,
      {
        ...flight,
        id: "probe-morning",
        flightNo: "TEST100",
        positions: ["G01"],
        startTime: "08:00",
        endTime: "10:00",
      },
    ];
    state.templates = state.flights.map((f) => ({ ...f }));
    state.shared.templates = state.templates;
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "TR", position: "H05" },
    ];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.dutyRosterOverrides = [];
    state.assignments = state.flights.map((f, i) =>
      makeUnfilled(f, state.positionRules[i].name, state.positionRules[i])
    );
    state.history = state.assignments.map((a, i) => ({
      ...a,
      id: `past-${i}`,
      date: "2026-11-01",
      staffId: state.staff[i].id,
      staffName: state.staff[i].name,
    }));
    state.activeScheduleDate = "2026-11-03";
    state.schedulePolicyStale = false;
    state.scheduleRuleFingerprint = scheduleRuleFingerprint(state);
    Object.assign(state.groups.A, {
      staff: state.staff,
      positionRules: state.positionRules,
      flights: state.flights,
      settings: state.settings,
      history: state.history,
      assignments: state.assignments,
      activeScheduleDate: state.activeScheduleDate,
      dutyRosterOverrides: [],
      schedulePolicyStale: false,
      scheduleRuleFingerprint: state.scheduleRuleFingerprint,
    });
    localStorage.setItem("autoschedule.state.v1", JSON.stringify(state));
    localStorage.setItem("autoschedule.scheduleDate", "2026-11-03");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('nav button[title="排班"]').click();
  const inputs = page.locator(".schedule-name-input");
  await inputs.first().waitFor();
  const rows = await page.evaluate(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.map((a) => ({ id: a.id, flight: a.flightNo }))
  );
  for (let i = 0; i < rows.length; i++) {
    const input = page.locator(
      `[data-assignment-id="${rows[i].id}"] .schedule-name-input`
    );
    await input.fill(
      rows[i].flight === "TR121" ? "测试送资料人员" : "测试早班人员"
    );
    await input.press("Tab");
  }
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.every((a) => Boolean(a.staffId))
  );
  const warnings = await page.evaluate(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.flatMap((a) => a.manualOverrideWarnings ?? [])
      .map((w) => w.code)
  );
  assert.equal(
    warnings.filter((w) => w === "position-qualification").length,
    2
  );
  report.checks.actualManualQualificationWarningsBothPositions = true;
  await page.locator('nav button[title="统计"]').click();
  await page
    .getByRole("button", { name: "末班重点岗位统计类别：送资料", exact: true })
    .click();
  const late = page.locator(
    '.late-priority-count-detail[data-staff-id="probe-0"] summary'
  );
  assert.equal(await late.innerText(), "2");
  assert.equal(
    await page
      .locator(
        '.ordinary-priority-count-detail[data-staff-id="probe-0"][data-position="H05"] summary'
      )
      .innerText(),
    "2"
  );
  const lateRow = page
    .locator(".relaxed-shift-table tbody tr")
    .filter({ hasText: "测试送资料人员" });
  const morningRow = page
    .locator(".relaxed-shift-table tbody tr")
    .filter({ hasText: "测试早班人员" });
  assert.equal(await lateRow.locator("td").nth(1).innerText(), "0");
  assert.equal(await lateRow.locator("td").nth(3).innerText(), "2");
  assert.equal(await morningRow.locator("td").nth(1).innerText(), "2");
  assert.equal(await morningRow.locator("td").nth(3).innerText(), "2");
  report.checks.currentAndPastCounts = {
    delivery: 2,
    ordinaryH05: 2,
    lateAfternoonRest: 2,
    morningEarlyDeparture: 2,
    morningAfternoonRest: 2,
  };
  await page.screenshot({
    path: "docs/acceptance/evidence/2026-11-03-qualification-statistics-page.png",
    fullPage: true,
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('nav button[title="统计"]').click();
  await page
    .getByRole("button", { name: "末班重点岗位统计类别：送资料", exact: true })
    .click();
  assert.equal(await late.innerText(), "2");
  assert.equal(await morningRow.locator("td").nth(1).innerText(), "2");
  report.checks.persistedAfterReload = true;
  assert.deepEqual(errors, []);
  report.pageErrors = errors;
  writeFileSync(
    "docs/acceptance/evidence/2026-11-03-qualification-statistics-browser.txt",
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

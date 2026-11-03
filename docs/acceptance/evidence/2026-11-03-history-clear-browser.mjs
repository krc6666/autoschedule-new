import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const origin = "http://127.0.0.1:5193/";
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = {
  input:
    "Independent synthetic history: 2026-10-21, 6 flights, 54 positions. Current schedule 2026-11-03; other history 2026-10-19; separate duty record.",
  checks: {},
};
const model = () =>
  page.evaluate(() => document.querySelector("autoschedule-app").model);
const stored = () =>
  page.evaluate(() => localStorage.getItem("autoschedule.state.v1"));
const structure = (state) =>
  state.assignments.map((a) => [
    a.id,
    a.flightId,
    a.flightNo,
    a.positionRuleId,
    a.position,
    a.startTime,
    a.endTime,
    a.remark,
    a.manualRemark,
  ]);
const targetRows = (state) =>
  state.history.filter((r) => r.date === "2026-10-21" && r.flightNo !== "轮值");
const unrelatedRows = (state) =>
  state.history.filter((r) => r.date !== "2026-10-21" || r.flightNo === "轮值");
const clickClear = async (accept = true) => {
  page.once("dialog", (dialog) =>
    accept ? dialog.accept() : dialog.dismiss()
  );
  await page.getByRole("button", { name: "清空全部人员", exact: true }).click();
};
const edit = async () => {
  await page.locator('nav button[title="历史"]').click();
  await page
    .locator("details.history-day")
    .filter({ has: page.locator("summary strong", { hasText: "2026-10-21" }) })
    .getByRole("button", { name: "编辑该日排班", exact: true })
    .click();
  await page
    .locator(".schedule-toolbar button")
    .filter({ hasText: "保存并更新历史" })
    .waitFor();
};
const save = async () => {
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".schedule-toolbar button")
    .filter({ hasText: "保存并更新历史" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("autoschedule-app").view.historyEditDate === null
  );
};
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { createDefaultState } = await import("/src/defaults.ts");
    const { restorePersistedState } =
      await import("/src/infrastructure/state-restoration.ts");
    const { scheduleRuleFingerprint } =
      await import("/src/domain/rules/schedule-rule-fingerprint.ts");
    const state = createDefaultState();
    const person = { ...state.staff[0], id: "synthetic-a", name: "测试人员甲" };
    const baseFlight = state.flights[0];
    const baseRule = state.positionRules[0];
    state.staff = [person];
    state.templates = Array.from({ length: 6 }, (_, i) => ({
      ...baseFlight,
      id: `synthetic-template-${i}`,
      flightNo: `TEST00${i + 1}`,
      startTime: `${String(6 + i * 3).padStart(2, "0")}:00`,
      endTime: `${String(8 + i * 3).padStart(2, "0")}:00`,
      positions: Array.from({ length: 9 }, (_, j) => `测试岗位${j + 1}`),
    }));
    state.shared.templates = state.templates;
    state.positionRules = state.templates.flatMap((flight, i) =>
      flight.positions.map((name, j) => ({
        ...baseRule,
        id: `synthetic-rule-${i}-${j}`,
        flightNo: flight.flightNo,
        name,
        category: "常规",
        qualifiedStaffIds: [person.id],
        manual: false,
      }))
    );
    state.flights = state.templates.map((flight) => ({
      ...flight,
      bookedPassengers: 100,
    }));
    state.assignments = [
      {
        id: "current-slot",
        flightId: state.flights[0].id,
        flightNo: state.flights[0].flightNo,
        positionRuleId: state.positionRules[0].id,
        position: state.positionRules[0].name,
        staffId: person.id,
        staffName: person.name,
        startTime: "06:00",
        endTime: "08:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "当前班表保持",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.history = state.positionRules.map((rule, i) => ({
      id: `history-${i}`,
      date: "2026-10-21",
      flightNo: rule.flightNo,
      position: rule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: state.templates[Math.floor(i / 9)].startTime,
      endTime: state.templates[Math.floor(i / 9)].endTime,
      workHours: 2,
      fatiguePoints: 2,
      remark: "保留岗位备注",
      historyCoverage: "complete",
      assignmentRemarks: {
        remark: "保留岗位备注",
        manualRemark: "保留手工备注",
      },
    }));
    state.history.push({
      ...state.history[0],
      id: "other-history-date",
      date: "2026-10-19",
    });
    state.history.push({
      ...state.history[0],
      id: "history-duty",
      flightNo: "轮值",
      position: "值班",
    });
    state.activeScheduleDate = "2026-11-03";
    Object.assign(state.groups.A, {
      staff: state.staff,
      flights: state.flights,
      positionRules: state.positionRules,
      settings: state.settings,
      assignments: state.assignments,
      history: state.history,
      activeScheduleDate: state.activeScheduleDate,
    });
    const normalized = restorePersistedState(state, createDefaultState());
    normalized.scheduleRuleFingerprint = scheduleRuleFingerprint(normalized);
    normalized.schedulePolicyStale = false;
    Object.assign(normalized.groups.A, {
      scheduleRuleFingerprint: normalized.scheduleRuleFingerprint,
      schedulePolicyStale: false,
    });
    localStorage.setItem("autoschedule.state.v1", JSON.stringify(normalized));
    localStorage.setItem("autoschedule.scheduleDate", "2026-11-03");
  });
  await page.reload({ waitUntil: "networkidle" });
  const original = await model();
  const originalStored = await stored();
  await edit();
  const draft = await model();
  assert.equal(draft.assignments.length, 54);
  assert.equal(draft.flights.length, 6);
  await clickClear(false);
  assert.deepEqual((await model()).assignments, draft.assignments);
  assert.equal(await stored(), originalStored);
  evidence.checks.declineClearKeepsDraftAndStorage = true;
  await clickClear();
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.every((a) => !a.staffId && !a.staffName)
  );
  const cleared = await model();
  assert.deepEqual(structure(cleared), structure(draft));
  assert.equal(await page.locator('th[colspan="2"]').count(), 6);
  assert.equal(await page.locator(".schedule-name-input").count(), 54);
  assert.ok(
    await page
      .locator(".schedule-name-input")
      .evaluateAll((inputs) => inputs.every((i) => !i.value))
  );
  assert.deepEqual(cleared.history, original.history);
  assert.equal(await stored(), originalStored);
  evidence.checks.redCrossClears54PeopleKeepsSixFlightsPositionsRemarks = true;
  evidence.checks.draftDoesNotPersistOrChangeOriginalHistory = true;
  await page.screenshot({
    path: "docs/acceptance/evidence/2026-11-03-history-clear-page.png",
    fullPage: true,
  });
  await page
    .locator(".schedule-toolbar button")
    .filter({ hasText: "取消编辑" })
    .click();
  const cancelled = await model();
  assert.deepEqual(cancelled.assignments, original.assignments);
  assert.deepEqual(cancelled.history, original.history);
  assert.deepEqual(cancelled.flights, original.flights);
  evidence.checks.cancelRestoresOriginalScheduleAndHistory = true;

  await edit();
  await clickClear();
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.every((a) => !a.staffId)
  );
  await save();
  const saved = await model();
  assert.equal(targetRows(saved).length, 54);
  assert.ok(
    targetRows(saved).every(
      (r) =>
        !r.staffId && !r.staffName && r.workHours === 0 && r.fatiguePoints === 0
    )
  );
  assert.deepEqual(unrelatedRows(saved), unrelatedRows(original));
  assert.deepEqual(saved.assignments, original.assignments);
  assert.deepEqual(saved.groups.B, original.groups.B);
  evidence.checks.save54EmptyHistoryRowsPreservesCurrentOtherDateDutyAndGroup = true;
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(targetRows(await model()).length, 54);
  assert.ok(targetRows(await model()).every((r) => !r.staffId && !r.staffName));
  await edit();
  assert.equal(await page.locator(".schedule-name-input").count(), 54);
  assert.ok(
    (await model()).assignments.every((a) => !a.staffId && !a.staffName)
  );
  evidence.checks.refreshAndReeditKeep54EmptyPositions = true;
  const input = page.locator(".schedule-name-input").first();
  await input.fill("测试人员甲");
  await input.press("Tab");
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.some((a) => a.staffId === "synthetic-a")
  );
  await save();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(targetRows(await model()).filter((r) => r.staffId).length, 1);
  assert.deepEqual(unrelatedRows(await model()), unrelatedRows(original));
  evidence.checks.refillOneHistoryPersonSaveAndReload = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await edit();
  await clickClear();
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.every((a) => !a.staffId)
  );
  assert.equal(await page.locator(".schedule-name-input").count(), 54);
  await page
    .locator(".schedule-toolbar button")
    .filter({ hasText: "取消编辑" })
    .click();
  assert.equal(targetRows(await model()).filter((r) => r.staffId).length, 1);
  evidence.checks.mobileClearAndCancelKeepSavedHistory = true;
  assert.deepEqual(errors, []);
  evidence.checks.noBrowserErrors = true;
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = String(error.stack ?? error);
  evidence.browserErrors = errors;
  evidence.body = await page.locator("body").innerText();
  throw error;
} finally {
  writeFileSync(
    "docs/acceptance/evidence/2026-11-03-history-clear-browser.txt",
    JSON.stringify(evidence, null, 2) + "\n"
  );
  await browser.close();
}
console.log(JSON.stringify(evidence, null, 2));

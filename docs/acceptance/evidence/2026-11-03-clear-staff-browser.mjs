import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

// Isolated synthetic data; never attaches to the owner's browser profile.
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = {
  date: "2026-11-03",
  input: "synthetic two flights; normal/manual/temporary positions",
  checks: {},
};
const getState = () =>
  page.evaluate(() => document.querySelector("autoschedule-app").model);
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
    a.layoutGroup,
    a.layoutIndex,
  ]);
try {
  await page.goto("http://127.0.0.1:5193/", { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { createDefaultState } = await import("/src/defaults.ts");
    const { scheduleRuleFingerprint } =
      await import("/src/domain/rules/schedule-rule-fingerprint.ts");
    const { restorePersistedState } =
      await import("/src/infrastructure/state-restoration.ts");
    const state = createDefaultState();
    const person = { ...state.staff[0], id: "synthetic-a", name: "测试人员甲" };
    const baseFlight = state.flights[0];
    const baseRule = state.positionRules[0];
    state.staff = [person];
    state.history = [];
    state.dutyRosterOverrides = [];
    state.flights = [0, 1].map((i) => ({
      ...baseFlight,
      id: `synthetic-flight-${i}`,
      flightNo: `TEST00${i + 1}`,
      startTime: i ? "14:00" : "08:00",
      endTime: i ? "16:00" : "10:00",
      positions: ["测试柜台", "测试手工岗位"],
    }));
    state.positionRules = state.flights.flatMap((flight, i) =>
      [0, 1].map((j) => ({
        ...baseRule,
        id: `synthetic-rule-${i}-${j}`,
        flightNo: flight.flightNo,
        name: j ? "测试手工岗位" : "测试柜台",
        qualifiedStaffIds: [person.id],
        category: "常规",
        manual: Boolean(j),
      }))
    );
    state.assignments = state.positionRules.map((rule, index) => {
      const flight = state.flights[Math.floor(index / 2)];
      return {
        id: `synthetic-assignment-${index}`,
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: person.id,
        staffName: person.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: 2,
        remark: "保留岗位备注",
        manualRemark: "保留手工备注",
        status: "assigned",
        layoutGroup: "primary",
        layoutIndex: index % 2,
      };
    });
    state.assignments.push({
      ...state.assignments[0],
      id: "synthetic-temp",
      positionRuleId: null,
      position: "测试临时岗位",
      status: "manual",
      layoutGroup: "bottom",
      layoutIndex: 0,
    });
    state.activeScheduleDate = "2026-11-03";
    state.schedulePolicyStale = false;
    state.scheduleRuleFingerprint = scheduleRuleFingerprint(state);
    Object.assign(state.groups.A, {
      staff: state.staff,
      flights: state.flights,
      positionRules: state.positionRules,
      settings: state.settings,
      assignments: state.assignments,
      history: state.history,
      dutyRosterOverrides: state.dutyRosterOverrides,
      activeScheduleDate: state.activeScheduleDate,
      schedulePolicyStale: false,
      scheduleRuleFingerprint: state.scheduleRuleFingerprint,
    });
    const normalized = restorePersistedState(state, createDefaultState());
    normalized.scheduleRuleFingerprint = scheduleRuleFingerprint(normalized);
    normalized.schedulePolicyStale = false;
    normalized.groups.A.scheduleRuleFingerprint =
      normalized.scheduleRuleFingerprint;
    normalized.groups.A.schedulePolicyStale = false;
    localStorage.setItem("autoschedule.state.v1", JSON.stringify(normalized));
    localStorage.setItem("autoschedule.scheduleDate", "2026-11-03");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('nav button[title="排班"]').click();
  await page
    .getByRole("button", { name: "清空全部人员", exact: true })
    .waitFor();
  const before = await getState();
  assert.equal(before.assignments.length, 5);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "清空全部人员", exact: true }).click();
  assert.deepEqual((await getState()).assignments, before.assignments);
  evidence.checks.cancelKeepsOriginal = true;

  page.once("dialog", async (dialog) => {
    assert.equal(
      dialog.message(),
      "确认清空当前班表所有岗位的人员？航班、岗位和备注都会保留。"
    );
    await dialog.accept();
  });
  await page.getByRole("button", { name: "清空全部人员", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.every((a) => !a.staffId && !a.staffName)
  );
  const cleared = await getState();
  assert.deepEqual(structure(cleared), structure(before));
  assert.deepEqual(cleared.flights, before.flights);
  assert.deepEqual(cleared.groups.B, before.groups.B);
  assert.equal(cleared.activeScheduleDate, before.activeScheduleDate);
  assert.equal(await page.locator('th[colspan="2"]').count(), 2);
  assert.equal(await page.locator(".schedule-name-input").count(), 5);
  assert.deepEqual(
    await page
      .locator(".schedule-name-input")
      .evaluateAll((inputs) => inputs.map((input) => input.value)),
    ["", "", "", "", ""]
  );
  evidence.checks.clearPreservesTwoFlightsFivePositionsAndRemarks = true;
  evidence.checks.allFivePeopleEmptyAndOtherGroupUnchanged = true;
  await page.screenshot({
    path: "docs/acceptance/evidence/2026-11-03-clear-staff-page.png",
    fullPage: true,
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.locator('nav button[title="排班"]').click();
  await page.locator(".schedule-name-input").first().waitFor();
  const restored = await getState();
  assert.deepEqual(structure(restored), structure(before));
  assert.ok(restored.assignments.every((a) => !a.staffId && !a.staffName));
  evidence.checks.reloadRetainsFiveEmptyPositions = true;
  const firstInput = page.locator(".schedule-name-input").first();
  await firstInput.fill("测试人员甲");
  await firstInput.press("Tab");
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.some((a) => a.staffId === "synthetic-a")
  );
  evidence.checks.manualRefillAfterReload = true;
  await page.reload({ waitUntil: "networkidle" });
  assert.ok(
    (await getState()).assignments.some((a) => a.staffId === "synthetic-a")
  );
  evidence.checks.refilledPersonPersists = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('nav button[title="排班"]').click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "清空全部人员", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.assignments.every((a) => !a.staffId && !a.staffName)
  );
  assert.equal(await page.locator(".schedule-name-input").count(), 5);
  assert.deepEqual(structure(await getState()), structure(before));
  evidence.checks.mobileClearRetainsAllFivePositions = true;
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
    "docs/acceptance/evidence/2026-11-03-clear-staff-browser.txt",
    JSON.stringify(evidence, null, 2) + "\n"
  );
  await browser.close();
}
console.log(JSON.stringify(evidence, null, 2));

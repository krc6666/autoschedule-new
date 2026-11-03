import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const report = {
  input:
    "Independent anonymous scenario: 2 flights, 6 positions, 8 qualified people; real Worker and HiGHS/WASM. Final result delivery held only to make the stop click deterministic; no synthetic solver result.",
  cases: [],
};
try {
  for (const entry of ["generate", "reschedule", "next"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:5193/", { waitUntil: "networkidle" });
    await page.evaluate(async (entry) => {
      const { createDefaultState } = await import("/src/defaults.ts");
      const state = createDefaultState();
      const basePerson = state.staff[0];
      state.staff = Array.from({ length: 8 }, (_, i) => ({
        ...basePerson,
        id: `test-${i}`,
        name: `测试人员${i + 1}`,
        status: "正常",
        staffType: "常规",
        teamLeader: false,
        dutyQualified: false,
        cxPreflightQualified: false,
        standbyQualified: false,
        nightQualified: true,
      }));
      const baseFlight = state.flights[0];
      state.flights = [13, 16].map((hour, i) => ({
        ...baseFlight,
        id: `test-flight-${i}`,
        flightNo: `TEST00${i + 1}`,
        startTime: `${hour}:00`,
        endTime: `${hour + 2}:00`,
        positions: ["G01", "G02", "G03"],
        bookedPassengers: 100,
      }));
      state.templates = state.flights.map((f) => ({
        ...f,
        id: `template-${f.id}`,
      }));
      const baseRule = state.positionRules[0];
      state.positionRules = state.flights.flatMap((f) =>
        f.positions.map((name, i) => ({
          ...baseRule,
          id: `rule-${f.id}-${i}`,
          flightNo: f.flightNo,
          name,
          category: "常规",
          enabled: true,
          manual: false,
          minPassengers: 0,
          qualifiedStaffIds: state.staff.map((p) => p.id),
          remark: "",
        }))
      );
      state.history = [];
      state.dutyRosterOverrides = [];
      state.assignments =
        entry === "generate"
          ? []
          : [
              {
                id: "source-slot",
                flightId: state.flights[0].id,
                flightNo: state.flights[0].flightNo,
                positionRuleId: state.positionRules[0].id,
                position: "G01",
                staffId: state.staff[0].id,
                staffName: state.staff[0].name,
                startTime: "13:00",
                endTime: "15:00",
                workHours: 2,
                fatiguePoints: 2,
                remark: "",
                manualRemark: "",
                status: "assigned",
              },
            ];
      state.activeScheduleDate = entry === "generate" ? null : "2026-11-03";
      state.settings.adminSupportEnabled = false;
      state.weeklyFlightPlans = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        flightNos: state.flights.map((f) => f.flightNo),
      }));
      state.shared.templates = state.templates;
      state.shared.weeklyFlightPlans = state.weeklyFlightPlans;
      Object.assign(state.groups.A, {
        staff: state.staff,
        flights: state.flights,
        positionRules: state.positionRules,
        settings: state.settings,
        assignments: state.assignments,
        history: [],
        dutyRosterOverrides: [],
        activeScheduleDate: state.activeScheduleDate,
      });
      const app = document.querySelector("autoschedule-app");
      app.commandHandler.store.getState().replaceModel(state);
      app.commandHandler.commit();
      localStorage.setItem("autoschedule.scheduleDate", "2026-11-03");
    }, entry);
    await page.reload({ waitUntil: "networkidle" });
    const original = await page.evaluate(
      () => document.querySelector("autoschedule-app").model
    );
    await page.evaluate(() => {
      const NativeWorker = window.Worker;
      window.__stopProbe = {
        safeCount: 0,
        heldFinal: false,
        terminated: 0,
        latest: null,
        adopted: null,
      };
      window.Worker = class {
        constructor(url, options) {
          this.inner = new NativeWorker(url, options);
          this.inner.onmessage = (event) => {
            if (event.data.type === "safe-result") {
              window.__stopProbe.safeCount++;
              window.__stopProbe.latest = structuredClone(event.data.result);
            }
            if (event.data.type === "result" && window.__stopProbe.latest) {
              window.__stopProbe.heldFinal = true;
              return;
            }
            this.onmessage?.(event);
          };
          this.inner.onerror = (event) => this.onerror?.(event);
        }
        postMessage(message) {
          this.inner.postMessage(message);
        }
        terminate() {
          window.__stopProbe.adopted = structuredClone(
            window.__stopProbe.latest
          );
          window.__stopProbe.terminated++;
          this.inner.terminate();
        }
      };
    });
    await page.locator('nav button[title="排班"]').click();
    if (entry === "generate")
      await page
        .locator(".empty-workspace button")
        .filter({ hasText: "生成排班" })
        .click();
    else
      await page
        .locator(".schedule-toolbar button")
        .filter({
          hasText: entry === "reschedule" ? "重新排班" : "归档并排后天",
        })
        .click();
    await page
      .getByRole("switch", { name: "是否启用行政支援模式", exact: true })
      .check();
    await page
      .getByRole("button")
      .filter({
        hasText:
          entry === "generate"
            ? "确认并生成排班"
            : entry === "reschedule"
              ? "确认并重新排班"
              : "归档并生成后天排班",
      })
      .click();
    const stop = page.getByRole("button", {
      name: "停止排班并采用当前方案",
      exact: true,
    });
    await stop.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector("autoschedule-app").view.progress
          .canAdoptCurrentResult,
      {},
      { timeout: 60000 }
    );
    await stop.click();
    await page.waitForFunction(
      () =>
        document.querySelector("autoschedule-app").view.progress.outcome ===
        "stopped-with-result"
    );
    const actual = await page.evaluate(() => ({
      model: document.querySelector("autoschedule-app").model,
      view: document.querySelector("autoschedule-app").view,
      probe: window.__stopProbe,
    }));
    assert.ok(actual.probe.safeCount > 0);
    assert.equal(actual.probe.terminated, 1);
    assert.equal(actual.model.assignments.length, 6);
    assert.ok(actual.model.assignments.some((a) => a.staffId));
    assert.deepEqual(
      actual.model.assignments,
      actual.probe.adopted.assignments
    );
    assert.equal(
      actual.model.activeScheduleDate,
      entry === "next" ? "2026-11-05" : "2026-11-03"
    );
    assert.equal(actual.view.date, actual.model.activeScheduleDate);
    assert.equal(actual.model.settings.adminSupportEnabled, true);
    assert.deepEqual(actual.model.groups.B, original.groups.B);
    assert.deepEqual(
      actual.model.weeklyFlightPlans,
      original.weeklyFlightPlans
    );
    assert.equal(await page.locator(".schedule-name-input").count(), 6);
    assert.deepEqual(
      (
        await page
          .locator(".schedule-name-input")
          .evaluateAll((inputs) => inputs.map((i) => i.value))
      ).sort(),
      actual.model.assignments.map((a) => a.staffName).sort()
    );
    if (entry === "next")
      assert.ok(
        actual.model.history.some(
          (r) => r.date === "2026-11-03" && r.staffId === "test-0"
        )
      );
    await page.screenshot({
      path: `docs/acceptance/evidence/2026-11-03-stop-adopt-${entry}.png`,
      fullPage: true,
    });
    const signature = (rows) =>
      rows.map((a) => [
        a.flightNo,
        a.position,
        a.staffId,
        a.staffName,
        a.startTime,
        a.endTime,
        a.workHours,
        a.fatiguePoints,
      ]);
    await page.reload({ waitUntil: "networkidle" });
    const restored = await page.evaluate(() => ({
      model: document.querySelector("autoschedule-app").model,
      date: document.querySelector("autoschedule-app").view.date,
    }));
    assert.deepEqual(
      signature(restored.model.assignments),
      signature(actual.model.assignments)
    );
    assert.equal(restored.date, actual.view.date);
    assert.equal(restored.model.settings.adminSupportEnabled, true);
    assert.deepEqual(errors, []);
    report.cases.push({
      entry,
      safeSnapshots: actual.probe.safeCount,
      finalDeliveryHeld: actual.probe.heldFinal,
      workersTerminated: actual.probe.terminated,
      positions: 6,
      assigned: actual.model.assignments.filter((a) => a.staffId).length,
      exactSnapshotAdopted: true,
      visibleInputsMatch: true,
      savedReloadMatches: true,
      date: actual.view.date,
      modeSaved: true,
      groupAndWeeklyPlanUnchanged: true,
      pageErrors: errors,
    });
    await context.close();
  }
  writeFileSync(
    "docs/acceptance/evidence/2026-11-03-stop-adopt-browser.txt",
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = {
  input:
    "anonymous overlapStaffingFixture through mountAutoscheduleApp, navigation and Store commands",
  checks: {},
};
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.route("**/src/main.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'import "/src/styles.css?import"; import "/node_modules/bootstrap/dist/css/bootstrap.min.css?import"; import "/node_modules/bootstrap-icons/font/bootstrap-icons.min.css?import";',
    })
  );
  await page.goto("http://127.0.0.1:55361/", { waitUntil: "networkidle" });
  report.facts = await page.evaluate(async () => {
    const { overlapStaffingFixture } =
      await import("/tests/helpers/overlap-staffing-fixture.ts");
    const { createAutoscheduleStore } =
      await import("/src/app/store/autoschedule-store.ts");
    const { mountAutoscheduleApp } = await import("/src/app.ts");
    const { scheduleRuleFingerprint } =
      await import("/src/domain/rules/schedule-rule-fingerprint.ts");
    const state = overlapStaffingFixture();
    state.schedulePolicyStale = false;
    state.scheduleRuleFingerprint = scheduleRuleFingerprint(
      state,
      state.activeScheduleDate
    );
    const persistence = {
      load: () => state,
      save: (model) => ({
        state: model,
        sizeBytes: JSON.stringify(model).length,
        nearCapacity: false,
      }),
      clear() {},
    };
    window.overlapStore = createAutoscheduleStore({
      initialState: state,
      persistence,
    });
    window.overlapApp = mountAutoscheduleApp(document.querySelector("#app"), {
      store: window.overlapStore,
      shouldWarnOnExit: () => false,
    });
    return {
      flights: state.flights,
      work: state.assignments,
      staff: state.staff.map(({ id, name }) => ({ id, name })),
    };
  });
  await page
    .locator(".app-nav button")
    .filter({ hasText: "排班" })
    .first()
    .click();
  const check = page.locator(".overlap-staffing-check");
  await check.waitFor();
  await check.locator("details > summary").first().click();
  report.checks.initial = await check.innerText();
  assert.match(report.checks.initial, /09:00—10:00/);
  assert.match(report.checks.initial, /AA101\/G01：缺岗/);
  assert.match(report.checks.initial, /直接检查通过：员工乙、员工丙、员工丁/);
  const minutes = (time) => {
    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute;
  };
  const intersection = [
    Math.max(
      ...report.facts.flights.map((flight) => minutes(flight.startTime))
    ),
    Math.min(...report.facts.flights.map((flight) => minutes(flight.endTime))),
  ];
  const independentIdle = report.facts.staff
    .filter(
      (person) =>
        !report.facts.work.some(
          (row) =>
            row.staffId === person.id &&
            minutes(row.startTime) < intersection[1] &&
            minutes(row.endTime) > intersection[0]
        )
    )
    .map((person) => person.name);
  assert.deepEqual(intersection, [540, 600]);
  assert.deepEqual(independentIdle, ["员工乙", "员工丙", "员工丁"]);
  for (const name of independentIdle)
    assert.ok(report.checks.initial.includes(name));
  report.checks.independent = { intersection, idle: independentIdle };
  report.checks.order = await page
    .locator(".daily-staff-flight-availability")
    .evaluate(
      (element) =>
        element.children.length === 3 &&
        element.nextElementSibling.classList.contains("overlap-staffing-check")
    );
  assert.equal(report.checks.order, true);
  await check.screenshot({
    path: "docs/acceptance/evidence/2026-11-18-overlap-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  report.checks.mobile = await check.evaluate((element) => ({
    fits: element.scrollWidth <= element.clientWidth + 1,
    visible: element.getBoundingClientRect().height > 0,
  }));
  assert.deepEqual(report.checks.mobile, { fits: true, visible: true });
  await check.screenshot({
    path: "docs/acceptance/evidence/2026-11-18-overlap-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() =>
    window.overlapStore.getState().schedule.assignStaff("t0", "p1")
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".overlap-staffing-check")
      ?.textContent.includes("未发现重叠")
  );
  report.checks.afterFill = await check.innerText();
  assert.ok(!report.checks.afterFill.includes("AA101/G01"));
  await page.evaluate(() => {
    const model = structuredClone(window.overlapStore.getState().model);
    model.positionRules.push({
      ...model.positionRules[0],
      id: "supervisor",
      name: "机动督导",
      category: "机动督导",
    });
    model.assignments.push({
      ...model.assignments[0],
      id: "source",
      positionRuleId: "supervisor",
      position: "机动督导",
      staffId: "p1",
      staffName: "员工乙",
      status: "assigned",
    });
    Object.assign(model.assignments[0], {
      staffId: "p1",
      staffName: "员工乙",
      status: "assigned",
      workHours: 0,
      supervisorSourceAssignmentId: "source",
    });
    window.overlapStore.getState().replaceModel(model);
  });
  await page.waitForFunction(() =>
    document
      .querySelector(".overlap-staffing-target")
      ?.textContent.includes("机动督导补位")
  );
  await check.locator("details > summary").first().click();
  report.checks.supervisorFill = await check.innerText();
  assert.match(report.checks.supervisorFill, /AA101\/G01：机动督导补位/);
  assert.match(report.checks.supervisorFill, /直接检查通过：员工丙、员工丁/);
  // No source role is removed by the diagnostic, and only the synthetic Store changed.
  report.checks.finalState = await page.evaluate(() => ({
    source: window.overlapStore
      .getState()
      .model.assignments.find((row) => row.id === "source").staffId,
    halfRest: window.overlapStore.getState().model.halfRestSelections,
  }));
  assert.equal(report.checks.finalState.source, "p1");
  assert.deepEqual(report.checks.finalState.halfRest, []);
  writeFileSync(
    "docs/acceptance/evidence/2026-11-18-overlap-final.html",
    (await check.evaluate((element) => element.outerHTML)) + "\n"
  );
  report.checks.errors = errors;
  assert.deepEqual(errors, []);
  report.status = "passed";
} finally {
  writeFileSync(
    "docs/acceptance/evidence/2026-11-18-overlap-browser.json",
    JSON.stringify(report, null, 2) + "\n"
  );
  await browser.close();
}
console.log(JSON.stringify(report.checks));

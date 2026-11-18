import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

// 隔离Chrome、匿名数据、内存Store，使用真实应用挂载/导航/人工命令。
// 只替换启动数据，不连接云端，不读取或改写owner浏览器资料。
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
const report = {
  input:
    "anonymous local app fixture; real mountAutoscheduleApp and Store commands",
  checks: {},
};
const lines = () =>
  page.locator(".daily-staff-flight-availability-row").evaluateAll((rows) =>
    rows.map((row) => ({
      label: row.querySelector("strong").textContent,
      names: row.querySelector("span").textContent.trim(),
    }))
  );
try {
  await page.route("**/src/main.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'import "/src/styles.css?import"; import "/node_modules/bootstrap/dist/css/bootstrap.min.css?import"; import "/node_modules/bootstrap-icons/font/bootstrap-icons.min.css?import";',
    })
  );
  await page.goto("http://127.0.0.1:55361/", { waitUntil: "networkidle" });
  report.inputFacts = await page.evaluate(async () => {
    const { createDefaultState } = await import("/src/defaults.ts");
    const { createAutoscheduleStore } =
      await import("/src/app/store/autoschedule-store.ts");
    const { mountAutoscheduleApp } = await import("/src/app.ts");
    const { scheduleRuleFingerprint } =
      await import("/src/domain/rules/schedule-rule-fingerprint.ts");
    const state = createDefaultState();
    const base = state.staff.find((person) => person.staffType === "常规");
    state.staff = ["员工甲", "员工乙", "员工丙"].map((name, index) => ({
      ...base,
      id: `anonymous-${index}`,
      name,
      teamLeader: false,
      status: "正常",
    }));
    state.history = [];
    state.halfRestSelections = [];
    state.activeScheduleDate = "2026-11-18";
    state.schedulePolicyStale = false;
    state.flights = [
      {
        id: "am",
        flightNo: "TEST101",
        startTime: "11:50",
        endTime: "13:00",
        remark: "",
        bookedPassengers: 0,
        positions: ["G01"],
      },
      {
        id: "pm",
        flightNo: "TEST102",
        startTime: "12:01",
        endTime: "14:00",
        remark: "",
        bookedPassengers: 0,
        positions: ["G01"],
      },
    ];
    state.positionRules = state.flights.map((flight, index) => ({
      ...state.positionRules[0],
      id: `rule-${index}`,
      flightNo: flight.flightNo,
      name: "G01",
      category: "常规",
      manual: false,
      qualifiedStaffIds: state.staff.map((person) => person.id),
      minPassengers: 0,
    }));
    state.assignments = state.flights.map((flight, index) => ({
      id: `task-${index}`,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: `rule-${index}`,
      position: "G01",
      staffId: state.staff[index].id,
      staffName: state.staff[index].name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 1,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    }));
    state.history = state.assignments
      .filter((entry) => entry.id === "task-0")
      .map((entry) => ({
        ...entry,
        id: "archived",
        date: "2026-11-16",
        historyCoverage: "complete",
      }));
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
    window.noFlightStore = createAutoscheduleStore({
      initialState: state,
      persistence,
    });
    window.noFlightApp = mountAutoscheduleApp(document.querySelector("#app"), {
      store: window.noFlightStore,
      shouldWarnOnExit: () => false,
    });
    return {
      staff: state.staff.map(({ id, name }) => ({ id, name })),
      assignments: state.assignments.map(({ staffId, startTime, endTime }) => ({
        staffId,
        startTime,
        endTime,
      })),
    };
  });
  await page
    .locator(".app-nav button")
    .filter({ hasText: "排班" })
    .first()
    .click();
  await page.locator(".daily-staff-flight-availability-row").first().waitFor();
  report.checks.initial = await lines();
  const startsByStaff = new Map(
    report.inputFacts.staff.map((person) => [
      person.id,
      report.inputFacts.assignments
        .filter((entry) => entry.staffId === person.id)
        .map((entry) => {
          const [hours, minutes] = entry.startTime.split(":").map(Number);
          return hours * 60 + minutes;
        }),
    ])
  );
  const independentlyCounted = [
    report.inputFacts.staff.filter(
      (person) => startsByStaff.get(person.id).length === 0
    ),
    report.inputFacts.staff.filter(
      (person) =>
        startsByStaff.get(person.id).length > 0 &&
        startsByStaff.get(person.id).every((start) => start > 720)
    ),
    report.inputFacts.staff.filter(
      (person) =>
        startsByStaff.get(person.id).length > 0 &&
        startsByStaff.get(person.id).every((start) => start <= 720)
    ),
  ].map((people) => people.map((person) => person.name).join("、") || "无");
  assert.deepEqual(
    report.checks.initial.map((row) => row.names),
    independentlyCounted
  );
  report.checks.independentInitialCounts = independentlyCounted;
  assert.deepEqual(
    report.checks.initial.map((row) => row.names),
    ["员工丙", "员工乙", "员工甲"]
  );
  assert.deepEqual(
    report.checks.initial.map((row) => row.label),
    ["全天无航班人员：", "上午无航班人员：", "中午以后无航班人员（半休）："]
  );
  report.checks.desktop = await page
    .locator(".daily-staff-flight-availability")
    .screenshot({
      path: "docs/acceptance/evidence/2026-11-18-no-flight-desktop.png",
    })
    .then(() => "captured");
  await page.setViewportSize({ width: 390, height: 844 });
  report.checks.mobile = await page
    .locator(".daily-staff-flight-availability")
    .evaluate((element) =>
      [...element.children].map((row) => {
        const bounds = row.getBoundingClientRect();
        return {
          width: bounds.width,
          height: bounds.height,
          fitsText: row.scrollWidth <= row.clientWidth + 1,
        };
      })
    );
  assert.ok(
    report.checks.mobile.every((row) => row.height > 0 && row.fitsText)
  );
  await page.locator(".daily-staff-flight-availability").screenshot({
    path: "docs/acceptance/evidence/2026-11-18-no-flight-mobile.png",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() =>
    window.noFlightStore
      .getState()
      .schedule.assignStaff("task-0", "anonymous-1")
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".daily-staff-flight-availability-row span")
        ?.textContent === "员工甲、员工丙"
  );
  report.checks.manualReassignment = await lines();
  assert.deepEqual(
    report.checks.manualReassignment.map((row) => row.names),
    ["员工甲、员工丙", "无", "无"]
  );
  // 清空是实际Store命令；必须只剩第一行名单，不能把全天无人重复列入半天名单。
  await page.evaluate(() =>
    window.noFlightStore.getState().schedule.clearStaff()
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".daily-staff-flight-availability-row span")
        ?.textContent === "员工甲、员工乙、员工丙"
  );
  report.checks.cleared = await lines();
  assert.deepEqual(
    report.checks.cleared.map((row) => row.names),
    ["员工甲、员工乙、员工丙", "无", "无"]
  );
  const query = page.getByLabel("人员航班查询日期");
  await query.fill("2026-11-16");
  await query.dispatchEvent("change");
  await page.waitForFunction(
    () =>
      document.querySelector(".daily-staff-flight-availability-row span")
        ?.textContent === "员工乙、员工丙"
  );
  report.checks.history = await lines();
  assert.deepEqual(
    report.checks.history.map((row) => row.names),
    ["员工乙、员工丙", "无", "员工甲"]
  );
  report.checks.halfRestSelections = await page.evaluate(
    () => window.noFlightStore.getState().model.halfRestSelections
  );
  assert.deepEqual(report.checks.halfRestSelections, []);
  await page.evaluate(() => {
    const model = structuredClone(window.noFlightStore.getState().model);
    model.staff = [model.staff[1]];
    model.assignments = model.assignments.map((entry) => ({
      ...entry,
      staffId: model.staff[0].id,
      staffName: model.staff[0].name,
      status: "assigned",
    }));
    window.noFlightStore.getState().replaceModel(model);
  });
  await query.fill("2026-11-18");
  await query.dispatchEvent("change");
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll(".daily-staff-flight-availability-row span"),
    ].every((span) => span.textContent === "无")
  );
  report.checks.emptyLists = await lines();
  assert.equal(report.checks.emptyLists.length, 3);
  assert.deepEqual(
    report.checks.emptyLists.map((row) => row.names),
    ["无", "无", "无"]
  );
  report.checks.errors = errors;
  assert.deepEqual(errors, []);
  report.status = "passed";
  await page
    .locator(".daily-staff-flight-availability")
    .evaluate((element) => element.outerHTML)
    .then((html) =>
      writeFileSync(
        "docs/acceptance/evidence/2026-11-18-no-flight-final.html",
        html + "\n"
      )
    );
} finally {
  writeFileSync(
    "docs/acceptance/evidence/2026-11-18-no-flight-browser.json",
    JSON.stringify(report, null, 2) + "\n"
  );
  await browser.close();
}
console.log(JSON.stringify(report));

import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:5193/", { waitUntil: "networkidle" });
  console.log(
    JSON.stringify(
      await page.evaluate(async () => {
        const { createDefaultState } = await import("/src/defaults.ts");
        const { buildMonthlyLatePriorityStatistics: late } =
          await import("/src/domain/statistics/monthly-late-priority-statistics.ts");
        const { buildOrdinaryPriorityStatistics: ordinary } =
          await import("/src/domain/statistics/ordinary-priority-statistics.ts");
        const { updateConfigurationField: update } =
          await import("/src/app/configuration-actions.ts");
        const { makeUnfilled } =
          await import("/src/domain/flights/schedule-position-rules.ts");
        const { buildHistoricalScheduleDraft, currentScheduleHistory } =
          await import("/src/app/history-actions.ts");
        const state = createDefaultState();
        const date = "2026-11-03";
        const rule = state.positionRules.find(
          (r) => r.flightNo === "TR121" && r.name === "H04"
        );
        const person = state.staff.find(
          (p) => p.id === rule.qualifiedStaffIds[0]
        );
        person.name = "测试人员";
        const flight = state.flights.find((f) => f.flightNo === "TR121");
        const summarize = () => ({
          late: late(state, date).rows.find((r) => r.staff.id === person.id)
            ?.flights.TR121.categories,
          ordinary: ordinary(state, date).filter(
            (r) =>
              r.staff.id === person.id &&
              r.airlineCode === "TR" &&
              r.position === "H04"
          ),
        });
        const a = {
          ...makeUnfilled(flight, rule.name, rule),
          staffId: person.id,
          staffName: "测试人员",
          status: "assigned",
        };
        state.activeScheduleDate = date;
        state.assignments = [a];
        state.history = [];
        const before = summarize();
        state.history = currentScheduleHistory(state, date);
        update(state, "position", rule.id, "remark", "申报/送资料");
        const archivedAfterEdit = summarize();
        const draft = buildHistoricalScheduleDraft(state, date);
        state.assignments = draft.assignments;
        const historyDraftAfterEdit = summarize();
        state.activeScheduleDate = date;
        state.assignments = [{ ...a, id: "fresh", remark: rule.remark }];
        const freshAfterEdit = summarize();
        return {
          before,
          archivedAfterEdit,
          historyDraftAfterEdit,
          freshAfterEdit,
        };
      }),
      null,
      2
    )
  );
} finally {
  await browser.close();
}

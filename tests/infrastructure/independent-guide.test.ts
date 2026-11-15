import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import { assignStaff } from "../../src/app/schedule-actions";
import {
  currentScheduleHistory,
  buildHistoricalScheduleDraft,
} from "../../src/app/history-actions";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { saveState, loadState } from "../../src/infrastructure/storage";
import { createDefaultState } from "../../src/defaults";
import {
  independentGuideScenario,
  GUIDE_DATE,
} from "../helpers/independent-guide-scenario";
import { workloadBalanceLoadSnapshots } from "../../src/domain/reviews/workload-balance";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { createTestAutoscheduleStore } from "../helpers/application";
import { join } from "node:path";

afterEach(() => vi.unstubAllGlobals());

it("下载模板保留独立引导的可选历史列", () => {
  const workbook = XLSX.readFile(
    join(process.cwd(), "public", "template", "排班工具配置模板.xlsx")
  );
  expect(
    XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets["历史排班"]!, {
      header: 1,
    })[0]
  ).toContain("引导安排");
});

it("真实Worker仍自动复用，Store清柜台转独立后保存、重启、导出和归档一致", async () => {
  const source = independentGuideScenario();
  source.assignments = [];
  const messages: ScheduleWorkerResponse[] = [];
  const host: {
    onmessage:
      ((e: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
    postMessage: (m: ScheduleWorkerResponse) => void;
  } = {
    onmessage: null,
    postMessage: (m) => messages.push(structuredClone(m)),
  };
  vi.stubGlobal("self", host);
  await import("../../src/schedule.worker");
  await host.onmessage!(
    new MessageEvent<ScheduleWorkerRequest>("message", {
      data: {
        state: createScheduleGenerationFacts(source),
        date: GUIDE_DATE,
        preferences: { halfRestStaffIds: [] },
      },
    })
  );
  expect(messages.filter((m) => m.type === "error")).toEqual([]);
  const response = messages.find((m) => m.type === "result");
  if (response?.type !== "result") throw new Error("Worker未返回班表");
  const automaticGuide = response.result.assignments.find(
    (a) => a.positionRuleId === "r2"
  )!;
  expect(automaticGuide.guideMode).toBeUndefined();
  expect(automaticGuide).toMatchObject({ workHours: 0, fatiguePoints: 0 });
  const store = createTestAutoscheduleStore(source);
  store.getState().schedule.install(GUIDE_DATE, response.result);
  const lower = store
    .getState()
    .model.assignments.find((a) => a.positionRuleId === "r1")!;
  const staffName = lower.staffName;
  const staffId = lower.staffId!;
  expect(staffId).toBeTruthy();
  store.getState().schedule.assignStaff(lower.id, "");
  expect(
    store
      .getState()
      .schedule.updateAssignment(automaticGuide.id, "staffName", staffName)
  ).toMatchObject({ changed: true });
  const current = restart(store.getState().model);
  expect(
    current.assignments.find((a) => a.id === automaticGuide.id)
  ).toMatchObject({
    staffId,
    guideMode: "independent",
    workHours: 2,
    fatiguePoints: 5,
  });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    throughBytes(buildScheduleWorkbook(current, GUIDE_DATE)).Sheets["排班结果"]!
  );
  expect(rows.find((r) => r["岗位"] === "柜台引导")).toMatchObject({
    人员编号: staffId,
    引导安排: "独立",
    "工作时长(小时)": 2,
    疲劳点数: 5,
  });
  current.history = currentScheduleHistory(current, GUIDE_DATE);
  const archived = restart(current);
  expect(
    archived.history.filter(
      (r) => r.staffId === staffId && r.position === "柜台引导"
    )
  ).toHaveLength(1);
  expect(
    workloadBalanceLoadSnapshots(archived, [], "2026-11-20", null).find(
      (r) => r.id === staffId
    )
  ).toMatchObject({ recentFatigue: 5, rollingHours: 2 });
});

function restart(state: ReturnType<typeof independentGuideScenario>) {
  let json = "";
  saveState(state, {
    setItem: (_key, value) => {
      json = value;
    },
  });
  return loadState({ getItem: () => json });
}

function throughBytes(book: XLSX.WorkBook) {
  return XLSX.read(XLSX.write(book, { bookType: "xlsx", type: "array" }), {
    type: "array",
  });
}

it("独立引导保存重启、归档、配置到空状态及结果Excel往返保留时段点数", () => {
  const source = independentGuideScenario();
  assignStaff(source, "a1", "");
  expect(assignStaff(source, "a2", "p1").changed).toBe(true);
  const restored = restart(source);
  expect(restored.assignments[2]).toMatchObject({
    guideMode: "independent",
    workHours: 2,
    fatiguePoints: 5,
    staffId: "p1",
  });
  restored.history = currentScheduleHistory(restored, GUIDE_DATE);
  expect(restored.history.filter((r) => r.staffId === "p1")).toHaveLength(1);
  const fresh = createDefaultState();
  const other = structuredClone(fresh.groups.B);
  expect(
    applyWorkbookImport(
      fresh,
      parseWorkbook(throughBytes(buildConfigWorkbook(restored)), []),
      "all"
    ).errors
  ).toBeUndefined();
  expect(fresh.groups.B).toEqual(other);
  const archived = restart(fresh);
  const record = archived.history.find((r) => r.position === "柜台引导");
  expect(record).toMatchObject({
    guideMode: "independent",
    staffId: "p1",
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 5,
  });
  const draft = buildHistoricalScheduleDraft(archived, GUIDE_DATE);
  expect(draft.warnings).toEqual([]);
  expect(
    draft.assignments.find((a) => a.position === "柜台引导")
  ).toMatchObject({
    guideMode: "independent",
    staffId: "p1",
    workHours: 2,
    fatiguePoints: 5,
  });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    throughBytes(buildScheduleWorkbook(restored, GUIDE_DATE)).Sheets[
      "排班结果"
    ]!
  );
  expect(rows.find((r) => r["岗位"] === "柜台引导")).toMatchObject({
    引导安排: "独立",
    "工作时长(小时)": 2,
    疲劳点数: 5,
  });
  const parsedResult = parseWorkbook(
    throughBytes(buildScheduleWorkbook(restored, GUIDE_DATE)),
    restored.staff
  );
  expect(
    parsedResult.history?.find((r) => r.position === "柜台引导")
  ).toMatchObject({ guideMode: "independent", workHours: 2, fatiguePoints: 5 });
  expect(
    workloadBalanceLoadSnapshots(
      restored,
      restored.assignments,
      GUIDE_DATE,
      null
    ).find((r) => r.id === "p1")
  ).toMatchObject({ todayHours: 2, todayFatigue: 5 });
});

it("旧数据和缺列不猜独立；原自动复用负荷仍为零", () => {
  const state = independentGuideScenario();
  expect(restart(state).assignments[2]?.guideMode).toBeUndefined();
  const book = buildScheduleWorkbook(state, GUIDE_DATE);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["排班结果"]!, {
    header: 1,
  });
  const index = rows[0]!.indexOf("引导安排");
  for (const row of rows) row.splice(index, 1);
  book.Sheets["排班结果"] = XLSX.utils.aoa_to_sheet(rows);
  const parsed = parseWorkbook(throughBytes(book), state.staff);
  expect(
    parsed.history?.find((r) => r.position === "柜台引导")?.guideMode
  ).toBeUndefined();
  expect(
    currentScheduleHistory(state, GUIDE_DATE).some(
      (r) => r.position === "柜台引导"
    )
  ).toBe(false);
});

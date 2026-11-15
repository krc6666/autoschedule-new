import { describe, expect, it } from "vitest";
import {
  assignStaff,
  updateAssignmentField,
} from "../../src/app/schedule-actions";
import {
  currentScheduleHistory,
  buildHistoricalScheduleDraft,
} from "../../src/app/history-actions";
import { isLegalGuideReuse } from "../../src/domain/flights/schedule-position-rules";
import { timeConflictAssignmentIds } from "../../src/domain/assignments/assignment-time-conflicts";
import { assertDailyScheduleSafety } from "../../src/domain/kernel/daily-schedule-safety";
import { diagnoseAutomaticAssignmentEligibility } from "../../src/domain/candidates/assignment-eligibility";
import { buildSchedulePageModel } from "../../src/ui/projections/schedule-page-model";
import {
  independentGuideScenario,
  GUIDE_DATE,
} from "../helpers/independent-guide-scenario";
import { compactRegularAssignments } from "../../src/domain/coverage/schedule-coverage";
import { createScheduleFrequencyFacts } from "../../src/domain/statistics/schedule-frequency";
import { recoverLocalScheduleIssues } from "../../src/domain/kernel/schedule-local-recovery";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import { monthlyCountRecords } from "../../src/domain/statistics/manual-count-evidence";
import { buildMonthlyStaffFatigue } from "../../src/domain/statistics/monthly-staff-fatigue";

describe("人工独立引导", () => {
  it.each([
    { startTime: "09:00", endTime: "10:30", hours: 1.5, points: 0 },
    { startTime: "23:00", endTime: "01:00", hours: 2, points: 5 },
  ])(
    "独立按实际时段$startTime—$endTime及配置$points点核算",
    ({ startTime, endTime, hours, points }) => {
      const state = independentGuideScenario();
      state.assignments[2]!.startTime = startTime;
      state.assignments[2]!.endTime = endTime;
      state.positionRules[2]!.fatiguePoints = points;
      expect(assignStaff(state, "a2", "p2").changed).toBe(true);
      expect(state.assignments[2]).toMatchObject({
        guideMode: "independent",
        workHours: hours,
        fatiguePoints: points,
      });
    }
  );
  it("独立人拖出换岗或清空后不遗留独立标记，双向负荷仍对应最终岗位", () => {
    const state = independentGuideScenario();
    assignStaff(state, "a2", "p2");
    expect(assignStaff(state, "a0", "p2", "a2").changed).toBe(true);
    expect(state.assignments[0]).toMatchObject({
      staffId: "p2",
      workHours: 2,
      fatiguePoints: 1,
    });
    expect(state.assignments[2]).toMatchObject({
      staffId: "p0",
      guideMode: "independent",
      workHours: 2,
      fatiguePoints: 5,
    });
    assignStaff(state, "a0", "");
    expect(assignStaff(state, "a0", "p0", "a2").changed).toBe(true);
    expect(state.assignments[2]).toMatchObject({
      staffId: "p1",
      workHours: 0,
      fatiguePoints: 0,
    });
    expect(state.assignments[2]?.guideMode).toBeUndefined();
  });

  it("独立计入当日月度疲劳及出勤，优先岗位次数例外保持归档前后一致", () => {
    const state = independentGuideScenario();
    assignStaff(state, "a2", "p2");
    expect(
      buildMonthlyStaffFatigue(state, "2026-11", GUIDE_DATE).rows.find(
        (r) => r.staff.id === "p2"
      )
    ).toMatchObject({ todayFatigue: 5, monthFatigue: 5 });
    expect(
      monthlyCountRecords(state, GUIDE_DATE).some(
        (r) => r.position === "柜台引导"
      )
    ).toBe(false);
    state.history = currentScheduleHistory(state, GUIDE_DATE);
    expect(
      createScheduleFrequencyFacts(state, "2026-11-20").recordsByStaffId.has(
        "p2"
      )
    ).toBe(false);
    state.assignments = [];
    expect(
      buildMonthlyStaffFatigue(state, "2026-11", GUIDE_DATE).rows.find(
        (r) => r.staff.id === "p2"
      )
    ).toMatchObject({ todayFatigue: 5, monthFatigue: 5 });
    expect(
      monthlyCountRecords(state, GUIDE_DATE).some(
        (r) => r.position === "柜台引导"
      )
    ).toBe(false);
  });
  it("后置柜台压缩及局部恢复均保留独立引导", () => {
    const state = independentGuideScenario();
    expect(assignStaff(state, "a2", "p2").changed).toBe(true);
    assignStaff(state, "a0", "");
    const guide = structuredClone(state.assignments[2]!);
    const changed = compactRegularAssignments(
      state,
      state.assignments,
      new Set(),
      GUIDE_DATE,
      createScheduleFrequencyFacts(state, GUIDE_DATE)
    );
    expect(changed.has("flight")).toBe(true);
    expect(state.assignments[2]).toEqual(guide);
    const warnings = recoverLocalScheduleIssues(
      state,
      state.assignments,
      (rows) => {
        if (rows[0]?.staffId)
          throw new ScheduleGuardError([
            { ruleId: "time-conflict", assignmentId: "a0", message: "冲突" },
          ]);
      }
    );
    expect(warnings.length).toBe(1);
    expect(state.assignments[2]).toEqual(guide);
  });

  it("独立引导在两个方向参与跨航班最小衔接，仍按人工规则落位并提示", () => {
    const state = independentGuideScenario();
    const extraFlight = {
      ...state.flights[0]!,
      id: "next",
      flightNo: "CD456",
      startTime: "10:30",
      endTime: "12:30",
    };
    state.flights.push(extraFlight);
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "next-rule",
      flightNo: "CD456",
    });
    state.assignments.push({
      ...state.assignments[0]!,
      id: "next-row",
      flightId: "next",
      flightNo: "CD456",
      positionRuleId: "next-rule",
      staffId: "p2",
      staffName: "人员2",
      startTime: "10:30",
      endTime: "12:30",
    });
    expect(assignStaff(state, "a2", "p2").changed).toBe(true);
    expect(
      state.assignments[2]?.manualOverrideWarnings?.map((w) => w.code)
    ).toContain("minimum-flight-transition");
    expect(assignStaff(state, "next-row", "p2").changed).toBe(true);
    expect(
      state.assignments[3]?.manualOverrideWarnings?.map((w) => w.code)
    ).toContain("minimum-flight-transition");
  });
  it("清柜台再填同人做独立引导，改其他柜台不改独立人，归档与历史编辑保留负荷", () => {
    const state = independentGuideScenario();
    expect(assignStaff(state, "a1", "").changed).toBe(true);
    expect(
      updateAssignmentField(state, "a2", "staffName", "人员1")
    ).toMatchObject({ changed: true });
    expect(state.assignments[2]).toMatchObject({
      staffId: "p1",
      guideMode: "independent",
      status: "assigned",
      workHours: 2,
      fatiguePoints: 5,
    });
    expect(assignStaff(state, "a0", "p2").changed).toBe(true);
    expect(state.assignments[2]).toMatchObject({
      staffId: "p1",
      workHours: 2,
      fatiguePoints: 5,
    });
    state.history = currentScheduleHistory(state, GUIDE_DATE);
    expect(state.history.find((r) => r.position === "柜台引导")).toMatchObject({
      guideMode: "independent",
      staffId: "p1",
      workHours: 2,
      fatiguePoints: 5,
    });
    expect(
      buildHistoricalScheduleDraft(state, GUIDE_DATE).assignments.find(
        (a) => a.position === "柜台引导"
      )
    ).toMatchObject({
      guideMode: "independent",
      workHours: 2,
      fatiguePoints: 5,
    });
  });

  it("柜台人员兼任仍为零负荷，清空独立再选柜台人可回到兼任", () => {
    const state = independentGuideScenario();
    expect(assignStaff(state, "a2", "p2").changed).toBe(true);
    expect(assignStaff(state, "a2", "").changed).toBe(true);
    expect(state.assignments[2]?.guideMode).toBeUndefined();
    expect(assignStaff(state, "a2", "p0").changed).toBe(true);
    expect(state.assignments[2]).toMatchObject({
      staffId: "p0",
      status: "manual",
      workHours: 0,
      fatiguePoints: 0,
    });
    expect(
      currentScheduleHistory(state, GUIDE_DATE).filter(
        (r) => r.position === "柜台引导"
      )
    ).toEqual([]);
  });

  it("名单包含独立人选，病休、行政人员、夜班能力不足仍不能手填", () => {
    const state = independentGuideScenario();
    expect(
      buildSchedulePageModel(state, GUIDE_DATE, {
        zoom: 1,
      }).groups[0]?.guideCandidates.map((p) => p.id)
    ).toContain("p2");
    state.staff[2]!.status = "休假";
    expect(assignStaff(state, "a2", "p2").changed).toBe(false);
    state.staff[2]!.status = "正常";
    state.staff[2]!.staffType = "行政支援";
    state.settings.adminSupportEnabled = true;
    expect(assignStaff(state, "a2", "p2").changed).toBe(false);
    state.staff[2]!.staffType = "常规";
    state.staff[2]!.nightShift = false;
    state.flights[0]!.startTime = "23:00";
    state.flights[0]!.endTime = "01:00";
    state.assignments[2]!.startTime = "23:00";
    state.assignments[2]!.endTime = "01:00";
    expect(assignStaff(state, "a2", "p2").changed).toBe(false);
  });

  it("独立按实际时段算工时并告警，不能获得同航班复用并发豁免", () => {
    const state = independentGuideScenario();
    state.settings.maxDailyHours = 1;
    const result = assignStaff(state, "a2", "p2");
    expect(result.changed).toBe(true);
    expect(
      state.assignments[2]?.manualOverrideWarnings?.map((w) => w.code)
    ).toContain("daily-hours");
    expect(assignStaff(state, "a1", "p2").changed).toBe(true);
    expect(
      isLegalGuideReuse(state, state.assignments[1]!, state.assignments[2]!)
    ).toBe(false);
    expect(timeConflictAssignmentIds(state, state.assignments)).toContain("a2");
  });

  it("最终复核接受合法独立安排，拒绝丢负荷/病休/无警告重叠；旧复用无来源仍拒绝", () => {
    const state = independentGuideScenario();
    expect(assignStaff(state, "a2", "p2").changed).toBe(true);
    const check = () =>
      assertDailyScheduleSafety({
        state,
        date: GUIDE_DATE,
        assignments: state.assignments,
        tasks: [],
        evaluateEligibility: diagnoseAutomaticAssignmentEligibility,
      });
    expect(check).not.toThrow();
    state.assignments[2]!.workHours = 0;
    expect(check).toThrow();
    state.assignments[2]!.workHours = 2;
    state.staff[2]!.status = "病假";
    expect(check).toThrow();
    state.staff[2]!.status = "正常";
    state.assignments[1]!.staffId = "p2";
    expect(check).toThrow();
    delete state.assignments[2]!.guideMode;
    state.assignments[1]!.staffId = "p1";
    state.assignments[2]!.workHours = 0;
    state.assignments[2]!.fatiguePoints = 0;
    expect(check).toThrow(/复用/);
  });
});

import { describe, expect, it } from "vitest";

import { createOrdinarySchedulingState } from "../helpers/scheduling-scenario";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { generateSchedule } from "../helpers/generate-schedule";
import type { Assignment, HistoryRecord } from "../../src/model";
import {
  buildHistoricalScheduleDraft,
  currentScheduleHistory,
  replaceHistoryForDate,
} from "../../src/app/history-actions";

function assignment(
  id: string,
  staffId: string,
  staffName: string
): Assignment {
  return {
    id,
    flightId: "flight-cx937",
    flightNo: "CX937",
    positionRuleId: null,
    position: "临时岗位",
    staffId,
    staffName,
    startTime: "08:30",
    endTime: "10:30",
    workHours: 2,
    fatiguePoints: 3,
    remark: "配置备注",
    manualRemark: "临时备注",
    status: "assigned",
  };
}

describe("history actions", () => {
  it("archives the source flight cutoff separately from an early-released assignment", () => {
    const state = createOrdinarySchedulingState();
    state.settings.dutyFatiguePoints = 0;
    const person = state.staff[0]!;
    state.flights = [
      {
        id: "flight-ak151",
        flightNo: "AK151",
        startTime: "21:05",
        endTime: "23:05",
        bookedPassengers: 0,
        positions: ["G09"],
        remark: "",
      },
    ];
    state.assignments = [
      {
        ...assignment("released-ak151", person.id, person.name),
        flightId: "flight-ak151",
        flightNo: "AK151",
        startTime: "21:05",
        endTime: "22:10",
        workHours: 1.08,
      },
    ];

    expect(currentScheduleHistory(state, "2026-10-01")[0]).toMatchObject({
      endTime: "22:10",
      flightCutoffTime: "23:05",
    });
  });

  it("archives the team-leader gap-fill source with normal workload", () => {
    const state = createOrdinarySchedulingState();
    state.settings.dutyFatiguePoints = 0;
    const person = state.staff[0]!;
    state.assignments = [
      {
        ...assignment("gap-fill-supervisor", person.id, person.name),
        position: "督导",
        teamLeaderGapFill: true,
      },
    ];

    expect(currentScheduleHistory(state, "2026-09-22")).toMatchObject([
      {
        staffId: person.id,
        position: "督导",
        workHours: 2,
        fatiguePoints: 3,
        teamLeaderGapFill: true,
      },
    ]);
  });

  it("rebuilds an archived day from the matching current flight template", () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    state.flights = [
      {
        id: "current-unrelated",
        flightNo: "CURRENT",
        startTime: "12:00",
        endTime: "14:00",
        bookedPassengers: 0,
        positions: [],
        remark: "",
      },
    ];
    state.templates = [
      {
        id: "template-cx937-early",
        flightNo: "CX937(早)",
        startTime: "08:30",
        endTime: "10:30",
        positions: [],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...state.positionRules[0]!,
        id: "cx937-early-g01",
        flightNo: "CX937(早)",
        name: "G01",
        remark: "当前配置备注",
        qualifiedStaffIds: [person.id],
      },
    ];
    state.history = [
      {
        id: "archived-cx937-early",
        date: "2026-08-20",
        flightNo: "CX937(早)",
        position: "G01",
        staffId: person.id,
        staffName: person.name,
        startTime: "08:20",
        endTime: "10:20",
        workHours: 2,
        fatiguePoints: 3,
        remark: "历史备注",
        historyCoverage: "complete",
      },
    ];
    state.history.push({
      id: "archived-duty",
      date: "2026-08-20",
      flightNo: "轮值",
      position: "值班人员",
      staffId: person.id,
      staffName: person.name,
      startTime: "",
      endTime: "",
      workHours: 0,
      fatiguePoints: 12,
      remark: "月度轮值",
    });

    const draft = buildHistoricalScheduleDraft(state, "2026-08-20");

    expect(draft.warnings).toEqual([]);
    expect(draft.flights).toMatchObject([
      {
        flightNo: "CX937(早)",
        startTime: "08:30",
        endTime: "10:30",
      },
    ]);
    expect(draft.assignments).toMatchObject([
      {
        flightNo: "CX937(早)",
        position: "G01",
        staffId: person.id,
        staffName: person.name,
        startTime: "08:30",
        endTime: "10:30",
        remark: "历史备注",
        manualRemark: "",
        status: "assigned",
      },
    ]);
  });

  it("refuses a partial archive or records missing from current configuration", () => {
    const state = createOrdinarySchedulingState();
    state.history = [
      {
        id: "partial",
        date: "2026-08-20",
        flightNo: "TR121",
        position: "H02",
        staffId: state.staff[0]!.id,
        staffName: state.staff[0]!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 4,
        remark: "一号",
        historyCoverage: "late-priority-only",
      },
    ];
    expect(buildHistoricalScheduleDraft(state, "2026-08-20")).toMatchObject({
      assignments: [],
      flights: [],
      warnings: ["该日期只有末班重点历史记录，不能还原完整排班"],
    });

    state.history = [
      {
        ...state.history[0]!,
        id: "missing-template",
        flightNo: "已删除航班",
        position: "已删除岗位",
        historyCoverage: "complete",
      },
    ];
    const missing = buildHistoricalScheduleDraft(state, "2026-08-20");
    expect(missing.assignments).toEqual([]);
    expect(missing.warnings.join("；")).toContain("已删除航班");
    expect(missing.warnings.join("；")).toContain("当前航班模板");
  });

  it("reports a duty-only date as having no editable flight positions", () => {
    const state = createOrdinarySchedulingState();
    state.history = [
      {
        id: "duty-only",
        date: "2026-08-20",
        flightNo: "轮值",
        position: "值班人员",
        staffId: state.staff[0]!.id,
        staffName: state.staff[0]!.name,
        startTime: "",
        endTime: "",
        workHours: 0,
        fatiguePoints: 12,
        remark: "月度轮值",
      },
    ];

    expect(buildHistoricalScheduleDraft(state, "2026-08-20")).toEqual({
      flights: [],
      assignments: [],
      warnings: ["该日期没有可编辑的航班岗位记录"],
    });
  });

  it("archives only available workers and adds duty fatigue once", () => {
    const state = createOrdinarySchedulingState();
    const available = state.staff[0]!;
    const unavailable = state.staff[1]!;
    unavailable.status = "病假";
    state.assignments = [
      assignment("available", available.id, available.name),
      assignment("unavailable", unavailable.id, unavailable.name),
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-07-25",
        cxPreflightStaffId: null,
        dutyStaffId: available.id,
        standbyStaffIds: [null, null],
      },
    ];

    const records = currentScheduleHistory(state, "2026-07-25");
    expect(records.map((record) => record.position)).toEqual([
      "临时岗位",
      "值班人员",
    ]);
    expect(records[0]?.remark).toBe("配置备注；临时备注");
    expect(records[1]?.fatiguePoints).toBe(state.settings.dutyFatiguePoints);
  });

  it("can preserve an already archived worker during historical editing", () => {
    const state = createOrdinarySchedulingState();
    state.settings.dutyFatiguePoints = 0;
    const person = state.staff[0]!;
    person.status = "病假";
    state.assignments = [assignment("archived-worker", person.id, person.name)];

    expect(currentScheduleHistory(state, "2026-07-25")).toEqual([]);
    expect(
      currentScheduleHistory(state, "2026-07-25", {
        includeUnavailableStaff: true,
      })
    ).toMatchObject([{ staffId: person.id, staffName: person.name }]);
  });

  it("archives manual override reasons without losing configured or manual remarks", () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    const item = assignment("manual-override", person.id, person.name);
    item.manualOverrideWarnings = [
      {
        code: "position-qualification",
        message: `${person.name} 不具备该岗位资质`,
      },
      { code: "daily-hours", message: `${person.name} 将超过每日工时上限` },
    ];
    state.assignments = [item];

    expect(currentScheduleHistory(state, "2026-07-25")[0]?.remark).toBe(
      `配置备注；临时备注；人工调整提醒：${person.name} 不具备该岗位资质；${person.name} 将超过每日工时上限`
    );
  });

  it("archives regular staff on administrative positions but excludes administrative staff", () => {
    const state = createOrdinarySchedulingState();
    state.settings.dutyFatiguePoints = 0;
    const regular = state.staff[0]!;
    const administrative = state.staff[1]!;
    administrative.staffType = "行政支援";
    const administrativeRule = {
      ...state.positionRules[0]!,
      id: "administrative-position",
      category: "行政支援" as const,
    };
    state.positionRules = [administrativeRule];
    state.assignments = [
      {
        ...assignment(
          "regular-on-administrative-position",
          regular.id,
          regular.name
        ),
        positionRuleId: administrativeRule.id,
      },
      {
        ...assignment(
          "administrative-worker",
          administrative.id,
          administrative.name
        ),
        positionRuleId: administrativeRule.id,
      },
    ];

    expect(currentScheduleHistory(state, "2026-07-25")).toMatchObject([
      {
        staffId: regular.id,
        position: "临时岗位",
        workHours: 2,
        fatiguePoints: 3,
      },
    ]);
  });

  it("does not archive guide reuse as additional workload", () => {
    const state = createOrdinarySchedulingState();
    state.settings.dutyFatiguePoints = 0;
    const person = state.staff[0]!;
    const guideRule = {
      ...state.positionRules[0]!,
      id: "guide-position",
      category: "引导" as const,
      fatiguePoints: 8,
    };
    state.positionRules = [guideRule];
    state.assignments = [
      {
        ...assignment("guide", person.id, person.name),
        positionRuleId: guideRule.id,
        position: guideRule.name,
        workHours: 0,
        fatiguePoints: 8,
      },
    ];

    expect(currentScheduleHistory(state, "2026-07-25")).toEqual([]);
  });

  it("replaces only the selected date", () => {
    const state = createOrdinarySchedulingState();
    const prior = { id: "prior", date: "2026-07-23" } as HistoryRecord;
    const replaced = { id: "old", date: "2026-07-25" } as HistoryRecord;
    const incoming = { id: "new", date: "2026-07-25" } as HistoryRecord;
    state.history = [prior, replaced];

    replaceHistoryForDate(state, "2026-07-25", [incoming]);
    expect(state.history.map((record) => record.id)).toEqual(["prior", "new"]);
  });

  it("preserves the priority remark through archive and protects the worker on the next workday", async () => {
    const state = createOrdinarySchedulingState();
    const selectedStaff = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = selectedStaff;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "tr121",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.positionRules = [
      {
        ...base,
        id: "tr-h02",
        flightNo: "TR121",
        name: "H02",
        category: "常规",
        remark: "一号",
        fatiguePoints: 1,
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "tr-h06",
        flightNo: "TR121",
        name: "H06",
        category: "常规",
        remark: "",
        fatiguePoints: 1,
        qualifiedStaffIds,
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionRotationEnabled = false;

    state.assignments = (
      await generateSchedule(state, "2026-08-14")
    ).assignments;
    const protectedWorkerId = state.assignments.find(
      (item) => item.position === "H02"
    )?.staffId;
    const protectedWorker = state.staff.find(
      (person) => person.id === protectedWorkerId
    )!;
    const replacement = state.staff.find(
      (person) => person.id !== protectedWorkerId
    )!;
    expect(protectedWorkerId).toBeDefined();
    const archived = currentScheduleHistory(state, "2026-08-14");
    expect(archived.find((record) => record.position === "H02")?.remark).toBe(
      "一号"
    );
    replaceHistoryForDate(state, "2026-08-14", archived);

    state.assignments = (
      await generateSchedule(state, "2026-08-16")
    ).assignments;
    expect(
      state.assignments.find((item) => item.position === "H02")?.staffId
    ).toBe(replacement.id);
    expect(
      state.assignments.find((item) => item.position === "H06")?.staffId
    ).toBe(protectedWorker.id);
    const feedback = buildScheduleFeedback(state, "2026-08-16").find(
      (item) => item.key === "previous-late"
    )!;
    expect(feedback.status).toBe("已执行");
    expect(feedback.text).toContain(`${protectedWorker.name} TR 一号`);
    expect(feedback.text).toContain(`${protectedWorker.name} 已避开`);
    expect(feedback.text).not.toContain("TR121/H02");
  });

  it("allows an unavoidable priority-position repeat and reports the exact fallback reason", async () => {
    const state = createOrdinarySchedulingState();
    const onlyQualified = state.staff.find(
      (person) => person.status === "正常"
    )!;
    state.staff = [onlyQualified];
    onlyQualified.dutyQualified = false;
    state.flights = [
      {
        id: "tr121",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "tr-h02",
        flightNo: "TR121",
        name: "H02",
        category: "常规",
        remark: "一号",
        fatiguePoints: 1,
        qualifiedStaffIds: [onlyQualified.id],
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionRotationEnabled = false;

    state.assignments = (
      await generateSchedule(state, "2026-08-14")
    ).assignments;
    replaceHistoryForDate(
      state,
      "2026-08-14",
      currentScheduleHistory(state, "2026-08-14")
    );
    state.assignments = (
      await generateSchedule(state, "2026-08-16")
    ).assignments;

    expect(state.assignments[0]).toMatchObject({
      staffId: onlyQualified.id,
      position: "H02",
    });
    const feedback = buildScheduleFeedback(state, "2026-08-16").find(
      (item) => item.key === "previous-late"
    )!;
    expect(feedback.status).toBe("需复核");
    expect(feedback.text).toContain(`${onlyQualified.name} 未落实（TR 一号`);
    expect(feedback.evidence).toContain("唯一合格");
  });

  it("reassigns an occupied qualified worker before breaking late-shift recovery protection", async () => {
    const state = createOrdinarySchedulingState();
    const [protectedWorker, replacement] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [protectedWorker!, replacement!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.teamLeader = false;
    });
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.flights = [
      {
        id: "previous-tr121",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...base,
        id: "previous-h02",
        flightNo: "TR121",
        name: "H02",
        category: "常规",
        remark: "一号",
        fatiguePoints: 1,
        qualifiedStaffIds,
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionRotationEnabled = false;
    state.assignments = (
      await generateSchedule(state, "2026-08-14")
    ).assignments;
    replaceHistoryForDate(
      state,
      "2026-08-14",
      currentScheduleHistory(state, "2026-08-14")
    );

    state.flights = [
      {
        id: "overlap",
        flightNo: "OVERLAP",
        startTime: "21:00",
        endTime: "23:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "tr121",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...base,
        id: "overlap-ordinary",
        flightNo: "OVERLAP",
        name: "G01",
        category: "常规",
        remark: "",
        fatiguePoints: 1,
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "tr-h05",
        flightNo: "TR121",
        name: "H05",
        category: "常规",
        remark: "送资料",
        fatiguePoints: 1,
        qualifiedStaffIds,
      },
    ];

    state.assignments = (
      await generateSchedule(state, "2026-08-16")
    ).assignments;

    expect(
      state.assignments.find((item) => item.positionRuleId === "tr-h05")
        ?.staffId
    ).toBe(replacement!.id);
    expect(
      state.assignments.find(
        (item) => item.positionRuleId === "overlap-ordinary"
      )?.staffId
    ).toBe(protectedWorker!.id);
    const feedback = buildScheduleFeedback(state, "2026-08-16").find(
      (item) => item.key === "previous-late"
    )!;
    expect(feedback.status).toBe("已执行");
    expect(feedback.text).toContain(`${protectedWorker!.name} 已避开`);
  });
});

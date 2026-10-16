import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { getDutyRosterForDate } from "../../src/domain/duty-roster/roster";
import { generateSchedule } from "../helpers/generate-schedule";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";

describe("schedule feedback", () => {
  it("does not warn when a free team leader has no assigned work", () => {
    const state = createDefaultState();
    const [teamLeader, regularWorker] = state.staff;
    state.staff = [teamLeader!, regularWorker!];
    teamLeader!.teamLeader = true;
    regularWorker!.teamLeader = false;
    state.flights = [];
    state.assignments = [];

    const feedback = buildScheduleFeedback(state, "2026-07-20");
    const coverage = feedback.find((item) => item.key === "coverage");

    expect(coverage?.text).not.toContain(teamLeader!.name);
    expect(coverage?.text).toContain(regularWorker!.name);
  });

  it("reports final flight-count spread and refreshes after a manual assignment change", () => {
    const state = createDefaultState();
    const [first, second, zero] = state.staff;
    state.staff = [first!, second!, zero!];
    first!.teamLeader = false;
    second!.teamLeader = false;
    zero!.teamLeader = false;
    [first!, second!, zero!].forEach((person) => {
      person.dutyQualified = false;
    });
    state.activeScheduleDate = "2026-10-04";
    state.assignments = [
      {
        id: "a-1",
        flightId: "flight-a",
        flightNo: "AA100",
        positionRuleId: null,
        position: "G01",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "06:00",
        endTime: "07:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "a-2",
        flightId: "flight-a",
        flightNo: "AA100",
        positionRuleId: null,
        position: "G02",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "06:00",
        endTime: "07:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "b-1",
        flightId: "flight-b",
        flightNo: "BB200",
        positionRuleId: null,
        position: "G01",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "09:00",
        endTime: "10:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "c-1",
        flightId: "flight-c",
        flightNo: "CC300",
        positionRuleId: null,
        position: "G01",
        staffId: second!.id,
        staffName: second!.name,
        startTime: "12:00",
        endTime: "13:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "d-1",
        flightId: "flight-d",
        flightNo: "DD400",
        positionRuleId: null,
        position: "G01",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "15:00",
        endTime: "16:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];

    const firstFeedback = buildScheduleFeedback(state, "2026-10-04").find(
      (item) => item.key === "daily-flight-count-balance"
    );

    expect(firstFeedback).toMatchObject({
      level: "attention",
      status: "需复核",
    });
    expect(firstFeedback?.text).toContain(first!.name);
    expect(firstFeedback?.text).toContain(second!.name);
    expect(firstFeedback?.text).toContain(zero!.name);
    expect(firstFeedback?.text).toContain("最多 3、最少 0、差距 3");

    state.assignments.find((item) => item.id === "b-1")!.staffId = zero!.id;
    state.assignments.find((item) => item.id === "b-1")!.staffName = zero!.name;
    const refreshed = buildScheduleFeedback(state, "2026-10-04").find(
      (item) => item.key === "daily-flight-count-balance"
    );

    expect(refreshed?.level).toBe("ok");
    expect(refreshed?.text).toContain("最多 2、最少 1、差距 1");
  });

  it("excludes the current duty worker from the final flight-count feedback", () => {
    const state = createDefaultState();
    const [duty, worker] = state.staff;
    state.staff = [duty!, worker!];
    state.dutyRosterOverrides = [
      {
        date: "2026-10-04",
        cxPreflightStaffId: null,
        dutyStaffId: duty!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.activeScheduleDate = "2026-10-04";
    state.assignments = [
      {
        id: "duty-flight",
        flightId: "flight-a",
        flightNo: "AA100",
        positionRuleId: null,
        position: "G01",
        staffId: duty!.id,
        staffName: duty!.name,
        startTime: "06:00",
        endTime: "07:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "worker-flight",
        flightId: "flight-b",
        flightNo: "BB200",
        positionRuleId: null,
        position: "G01",
        staffId: worker!.id,
        staffName: worker!.name,
        startTime: "08:00",
        endTime: "09:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];

    const feedback = buildScheduleFeedback(state, "2026-10-04").find(
      (item) => item.key === "daily-flight-count-balance"
    );

    expect(feedback?.level).toBe("ok");
    expect(feedback?.text).toContain("参与比较的正常常规人员不足两人");
    expect(feedback?.text).not.toContain(duty!.name);
  });

  it("excludes selected half-rest staff from final flight-count feedback when configured", () => {
    const state = createDefaultState();
    const [first, second] = state.staff;
    state.staff = [first!, second!];
    state.activeScheduleDate = "2026-10-04";
    state.assignments = [
      {
        id: "first-flight",
        flightId: "flight-a",
        flightNo: "AA100",
        positionRuleId: null,
        position: "G01",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "06:00",
        endTime: "07:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];

    const feedback = buildScheduleFeedback(state, "2026-10-04", {
      halfRestStaffIds: [second!.id],
    }).find((item) => item.key === "daily-flight-count-balance");

    expect(feedback?.level).toBe("ok");
    expect(feedback?.text).not.toContain(second!.name);
  });

  it("returns concise evidence-based items including duty arrangements and a missing history baseline", async () => {
    const state = createDefaultState();
    state.assignments = (
      await generateSchedule(state, "2026-07-20")
    ).assignments;
    const feedback = buildScheduleFeedback(state, "2026-07-20");
    expect(feedback).toHaveLength(14);
    expect(feedback.map((item) => item.label)).toEqual([
      "人员覆盖",
      "负荷均衡",
      "航班衔接",
      "人工调整提醒",
      "12点前岗位完整性",
      "跨工作日资质预留",
      "连续高负荷",
      "跨工作班动态平衡",
      "重点岗位频率均衡",
      "连续轮岗复核",
      "上一工作日晚班人员跟踪",
      "本班末班人员预告",
      "值班与轮值",
      "同一工作班航班数均衡",
    ]);
    expect(
      feedback.slice(0, 3).every((item) => item.group === "flight-staff")
    ).toBe(true);
    expect(
      feedback.slice(4).every((item) => item.group === "rule-execution")
    ).toBe(true);
    expect(
      feedback.every((item) =>
        ["已执行", "需复核", "无基准"].includes(item.status)
      )
    ).toBe(true);
    expect(
      feedback.every(
        (item) =>
          item.evidence.length > 0 &&
          (item.evidence === item.text ||
            item.evidence.startsWith(item.text.replace(/…$/, "")))
      )
    ).toBe(true);
    expect(feedback.find((item) => item.key === "previous-late")).toMatchObject(
      { status: "无基准", group: "rule-execution" }
    );
    expect(
      feedback.find((item) => item.key === "previous-late")?.text
    ).toContain("暂无最近工作日归档");
    expect(feedback.find((item) => item.key === "duty-roster")?.text).toContain(
      "值班"
    );
    expect(feedback.find((item) => item.key === "duty-roster")?.text).toContain(
      `+${state.settings.dutyFatiguePoints} 点疲劳`
    );
    expect(feedback.find((item) => item.key === "duty-roster")?.text).toContain(
      "12点前上午航班"
    );
    expect(feedback.find((item) => item.key === "fatigue")?.text).toContain(
      "工时差"
    );
    expect(feedback.find((item) => item.key === "fatigue")?.text).toContain(
      "当日疲劳差"
    );
    expect(feedback.find((item) => item.key === "coverage")?.text).toContain(
      "相邻航班起飞间隔"
    );
  }, 30_000);

  it("identifies tight transitions, repeated high load, uncovered staff, and late-shift overload", () => {
    const state = createDefaultState();
    const [worker, uncovered] = state.staff;
    state.staff = [worker!, uncovered!];
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "20:00",
        endTime: "21:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "f2",
        flightNo: "TR121",
        startTime: "21:15",
        endTime: "23:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.assignments = [
      {
        id: "a1",
        flightId: "f1",
        flightNo: "F1",
        positionRuleId: null,
        position: "P1",
        staffId: worker!.id,
        staffName: worker!.name,
        startTime: "20:00",
        endTime: "21:00",
        workHours: 1,
        fatiguePoints: 5,
        remark: "控制",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "a2",
        flightId: "f2",
        flightNo: "TR121",
        positionRuleId: null,
        position: "H02",
        staffId: worker!.id,
        staffName: worker!.name,
        startTime: "21:15",
        endTime: "23:15",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.history = [
      {
        id: "h1",
        date: "2026-07-18",
        flightNo: "TR121",
        position: "H02",
        staffId: worker!.id,
        staffName: worker!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
      },
    ];
    const feedback = buildScheduleFeedback(state, "2026-07-20");
    expect(feedback.find((item) => item.key === "coverage")).toMatchObject({
      level: "attention",
    });
    expect(feedback.find((item) => item.key === "coverage")?.text).toContain(
      uncovered!.name
    );
    expect(feedback.find((item) => item.key === "connections")?.text).toContain(
      "15 分钟"
    );
    expect(feedback.find((item) => item.key === "high-load")?.text).toContain(
      worker!.name
    );
    expect(feedback.find((item) => item.key === "high-load")?.text).toContain(
      "已超保护仍安排"
    );
    expect(
      feedback.find((item) => item.key === "previous-late")?.text
    ).toContain(`${worker!.name} 未落实（TR 一号`);
  });

  it("does not report a valid diversion transfer as a 90-minute violation", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    const baseRule = state.positionRules[0]!;
    state.staff = [person];
    state.flights = [
      {
        id: "source",
        flightNo: "AA100",
        startTime: "21:05",
        endTime: "23:05",
        bookedPassengers: 100,
        positions: ["G09"],
        remark: "",
      },
      {
        id: "target",
        flightNo: "BB200",
        startTime: "22:10",
        endTime: "00:10",
        bookedPassengers: 100,
        positions: ["G13"],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...baseRule,
        id: "source-rule",
        flightNo: "AA100",
        name: "G09",
        category: "分流",
        earlyReleaseMinutes: 60,
        qualifiedStaffIds: [person.id],
      },
      {
        ...baseRule,
        id: "target-rule",
        flightNo: "BB200",
        name: "G13",
        category: "常规",
        earlyReleaseMinutes: 0,
        qualifiedStaffIds: [person.id],
      },
    ];
    state.assignments = [
      {
        id: "source-assignment",
        flightId: "source",
        flightNo: "AA100",
        positionRuleId: "source-rule",
        position: "G09",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:05",
        endTime: "22:10",
        workHours: 65 / 60,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "target-assignment",
        flightId: "target",
        flightNo: "BB200",
        positionRuleId: "target-rule",
        position: "G13",
        staffId: person.id,
        staffName: person.name,
        startTime: "22:10",
        endTime: "00:10",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.settings.minimumRegularTransitionMinutes = 90;

    const feedback = buildScheduleFeedback(state, "2026-10-03").find(
      (item) => item.key === "connections"
    )!;

    expect(feedback.text).not.toContain("少于要求的 90 分钟");
  });

  it("reports an enabled position-transition rule when its minimum gap is not met", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    state.staff = [person];
    state.flights = [
      {
        id: "source",
        flightNo: "CX931",
        startTime: "17:00",
        endTime: "19:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target",
        flightNo: "TR121",
        startTime: "20:00",
        endTime: "22:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.assignments = [
      {
        id: "source-a",
        flightId: "source",
        flightNo: "CX931",
        positionRuleId: null,
        position: "G19",
        staffId: person.id,
        staffName: person.name,
        startTime: "17:00",
        endTime: "19:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "target-a",
        flightId: "target",
        flightNo: "TR121",
        positionRuleId: null,
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "20:00",
        endTime: "22:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    const connections = buildScheduleFeedback(state, "2026-07-20").find(
      (item) => item.key === "connections"
    )!;
    expect(connections.level).toBe("attention");
    expect(connections.evidence).toContain("TR121 H02 准备保护");
    expect(connections.evidence).toContain("要求至少 180 分钟");
    expect(connections.evidence).toContain("CX931/G19 17:00–19:00");
  });

  it("marks a previous late-shift worker used on a configured next-workday target as a protection override", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    state.staff = [person];
    state.flights = [
      {
        id: "early",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.assignments = [
      {
        id: "early-position",
        flightId: "early",
        flightNo: "KE166",
        positionRuleId: null,
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 2,
        remark: "一号",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-07-17",
        flightNo: "TR121",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
      },
    ];
    const feedback = buildScheduleFeedback(state, "2026-07-18").find(
      (item) => item.key === "previous-late"
    )!;
    expect(feedback.text).toContain(`${person.name} 未落实（KE 一号`);
    expect(feedback.text).not.toContain("KE166/H02");
    expect(feedback.evidence).toContain("具体原因未记录");
  });

  it("reports a cutoff override with compact flight code and position text without displaying times", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    state.staff = [person];
    state.settings.lateShiftRecoveryPositionRules.find(
      (rule) => rule.keyword === "一号"
    )!.nextWorkdayCutoffTime = "12:00";
    state.flights = [
      {
        id: "late",
        flightNo: "NIGHT300",
        startTime: "18:00",
        endTime: "20:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.assignments = [
      {
        id: "late-position",
        flightId: "late",
        flightNo: "NIGHT300",
        positionRuleId: null,
        position: "P1",
        staffId: person.id,
        staffName: person.name,
        startTime: "18:00",
        endTime: "20:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-07-17",
        flightNo: "TR121",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
      },
    ];

    const feedback = buildScheduleFeedback(state, "2026-07-18").find(
      (item) => item.key === "previous-late"
    )!;

    expect(feedback.text).toContain(`${person.name} TR 一号`);
    expect(feedback.text).toContain(`${person.name} 未落实（NIGHT P1`);
    expect(feedback.text).not.toContain("12:00");
    expect(feedback.text).not.toContain("18:00");
  });

  it("reports both previous-shift follow-up and the current late-shift protection list", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    state.staff = [person];
    state.flights = [
      {
        id: "late",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.assignments = [
      {
        id: "today",
        flightId: "late",
        flightNo: "TR121",
        positionRuleId: null,
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 8,
        remark: "一号",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.history = [
      {
        id: "previous",
        date: "2026-07-18",
        flightNo: "TR121",
        position: "H04",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 7,
        remark: "申报",
      },
    ];

    const feedback = buildScheduleFeedback(state, "2026-07-20");
    const previousLate =
      feedback.find((item) => item.key === "previous-late")?.text ?? "";
    expect(previousLate).toContain(`${person.name} TR 申报`);
    expect(previousLate).toContain(`${person.name} 未落实（TR 一号`);
    expect(previousLate).not.toContain("TR121/H02");
    expect(previousLate).not.toContain("疲劳");
    expect(
      feedback.find((item) => item.key === "current-late")?.text
    ).toContain(`${person.name} TR 一号`);
    expect(
      feedback.find((item) => item.key === "current-late")?.text
    ).toContain("下个工作日需执行恢复保护");
  });

  it("reports automatic duty recovery swaps and preserves manual duty conflicts", () => {
    const automatic = createDefaultState();
    const original = getDutyRosterForDate(automatic, "2026-08-01");
    const protectedWorker = automatic.staff.find(
      (person) => person.id === original.dutyStaffId
    )!;
    automatic.history = [
      {
        id: "previous-duty-priority",
        date: "2026-07-30",
        flightNo: "TR121",
        position: "H02",
        staffId: protectedWorker.id,
        staffName: protectedWorker.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];
    expect(
      buildScheduleFeedback(automatic, "2026-08-01").find(
        (item) => item.key === "duty-roster"
      )?.evidence
    ).toContain("自动值班恢复调整");

    const manual = createDefaultState();
    const manualOriginal = getDutyRosterForDate(manual, "2026-08-01");
    const manualWorker = manual.staff.find(
      (person) => person.id === manualOriginal.dutyStaffId
    )!;
    manual.dutyRosterOverrides = [
      {
        date: manualOriginal.date,
        cxPreflightStaffId: manualOriginal.cxPreflightStaffId,
        dutyStaffId: manualOriginal.dutyStaffId,
        standbyStaffIds: [...manualOriginal.standbyStaffIds],
      },
    ];
    manual.history = [
      {
        id: "previous-manual-priority",
        date: "2026-07-30",
        flightNo: "TR121",
        position: "H02",
        staffId: manualWorker.id,
        staffName: manualWorker.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];
    expect(
      buildScheduleFeedback(manual, "2026-08-01").find(
        (item) => item.key === "duty-roster"
      )?.evidence
    ).toContain("人工指定值班冲突");
  });

  it("explains whether the duty person received a preferred latest-flight position", async () => {
    const state = createDefaultState();
    state.staff = state.staff.slice(0, 6);
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.staff[5]!.cxPreflightQualified = true;
    state.flights = [
      {
        id: "early",
        flightNo: "EARLY",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "middle",
        flightNo: "MIDDLE",
        startTime: "15:00",
        endTime: "17:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late",
        flightNo: "LATE",
        startTime: "21:00",
        endTime: "23:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.positionRules = [
      ...Array.from({ length: 5 }, (_, index) => ({
        ...base,
        id: `early-position-${index}`,
        flightNo: "EARLY",
        name: `普通柜台${index + 1}`,
        remark: "",
        qualifiedStaffIds,
      })),
      {
        ...base,
        id: "late-first",
        flightNo: "LATE",
        name: "H02",
        remark: "一号",
        qualifiedStaffIds,
      },
    ];
    state.assignments = (
      await generateSchedule(state, "2026-07-20")
    ).assignments;
    const feedback = buildScheduleFeedback(state, "2026-07-20").find(
      (item) => item.key === "duty-roster"
    )!;
    expect(feedback.level).toBe("ok");
    expect(feedback.text).toContain("LATE/H02");
    expect(feedback.text).toContain("最晚航班");
    expect(feedback.text).toContain("符合值班晚撤规则");
    const dutyAssignment = state.assignments.find(
      (item) =>
        item.staffId &&
        feedback.text.includes(item.staffName) &&
        item.positionRuleId === "late-first"
    )!;
    dutyAssignment.startTime = "08:00";
    dutyAssignment.endTime = "10:00";
    dutyAssignment.flightNo = "EARLY";
    const abnormal = buildScheduleFeedback(state, "2026-07-20").find(
      (item) => item.key === "duty-roster"
    )!;
    expect(abnormal.level).toBe("attention");
    expect(abnormal.text).toContain("未满足值班晚撤规则");
  });

  it("reports the configured duty position priority that actually received the duty worker", async () => {
    const state = createDefaultState();
    state.staff = state.staff.slice(0, 6);
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.staff[5]!.cxPreflightQualified = true;
    state.flights = [
      {
        id: "early",
        flightNo: "EARLY",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "tr",
        flightNo: "TR121",
        startTime: "21:00",
        endTime: "23:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.positionRules = [
      ...Array.from({ length: 5 }, (_, index) => ({
        ...base,
        id: `early-${index}`,
        flightNo: "EARLY",
        name: `G0${index + 1}`,
        remark: "",
        qualifiedStaffIds,
      })),
      {
        ...base,
        id: "tr-first",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        qualifiedStaffIds,
      },
    ];
    state.assignments = (
      await generateSchedule(state, "2026-07-20")
    ).assignments;

    const feedback = buildScheduleFeedback(state, "2026-07-20").find(
      (item) => item.key === "duty-roster"
    )!;
    expect(feedback.text).toContain("配置优先级第 1 项 TR121/H02");
    expect(feedback.text).toContain("符合值班岗位优先顺序");
  });

  it("explains the second-latest fallback when the latest flight has no executable duty target", () => {
    const state = createDefaultState();
    state.staff = state.staff.slice(0, 6);
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.staff[5]!.cxPreflightQualified = true;
    state.flights = [
      {
        id: "early",
        flightNo: "EARLY",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second",
        flightNo: "SECOND",
        startTime: "20:00",
        endTime: "22:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "latest",
        flightNo: "LATEST",
        startTime: "22:30",
        endTime: "00:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const roster = getDutyRosterForDate(state, "2026-07-20");
    const duty = state.staff.find(
      (person) => person.id === roster.dutyStaffId
    )!;
    state.assignments = [
      {
        id: "duty-second",
        flightId: "second",
        flightNo: "SECOND",
        positionRuleId: null,
        position: "G17",
        staffId: duty.id,
        staffName: duty.name,
        startTime: "20:00",
        endTime: "22:00",
        workHours: 2,
        fatiguePoints: 4,
        remark: "申报",
        manualRemark: "",
        status: "assigned",
      },
    ];

    const feedback = buildScheduleFeedback(state, "2026-07-20").find(
      (item) => item.key === "duty-roster"
    )!;
    expect(feedback.text).toContain("倒数第二晚航班 SECOND/G17");
    expect(feedback.text).toContain("值班晚撤规则第二档位");
    expect(feedback.text).toContain("符合值班晚撤规则");
  });

  it("reports strict pre-noon overrides, reallocation vacancies, and objective staffing shortages", () => {
    const state = createDefaultState();
    state.flights = [
      {
        id: "source",
        flightNo: "SOURCE",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target",
        flightNo: "TARGET",
        startTime: "09:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "source-position",
        flightNo: "SOURCE",
        name: "G01",
        category: "常规",
      },
      {
        ...base,
        id: "target-position",
        flightNo: "TARGET",
        name: "H01",
        category: "常规",
      },
      {
        ...base,
        id: "short-position",
        flightNo: "TARGET",
        name: "H02",
        category: "常规",
      },
    ];
    const person = state.staff[0]!;
    state.staff = [person];
    state.assignments = [
      {
        id: "source-assignment",
        flightId: "source",
        flightNo: "SOURCE",
        positionRuleId: "source-position",
        position: "G01",
        staffId: null,
        staffName: "",
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "unfilled",
        systemNotes: ["因抽调至 TARGET/H01 而空缺"],
      },
      {
        id: "target-assignment",
        flightId: "target",
        flightNo: "TARGET",
        positionRuleId: "target-position",
        position: "H01",
        staffId: person.id,
        staffName: person.name,
        startTime: "09:00",
        endTime: "11:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
        systemNotes: ["已突破严格限制仍安排：早间严格衔接"],
      },
      {
        id: "short-assignment",
        flightId: "target",
        flightNo: "TARGET",
        positionRuleId: "short-position",
        position: "H02",
        staffId: null,
        staffName: "",
        startTime: "09:00",
        endTime: "11:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "unfilled",
        systemNotes: ["因合格人数不足而无法填满（缺少 1 人：时段冲突 1 人）"],
      },
    ];

    const feedback = buildScheduleFeedback(state, "2026-07-18");
    const morning = feedback.find((item) => item.key === "morning-priority")!;
    expect(morning.text).toContain("因抽调至 TARGET/H01 而空缺");
    expect(morning.text).toContain("因合格人数不足而无法填满");
    expect(morning.text).toContain("已突破严格限制仍安排");
  });
});

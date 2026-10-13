import * as XLSX from "xlsx-js-style";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { generateSchedule } from "../helpers/generate-schedule";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import { SCHEDULE_SETTING_DEFINITIONS } from "../../src/domain/rules/schedule-settings";
import { STRUCTURED_POLICY_DEFINITIONS } from "../../src/domain/rules/structured-policy-settings";
import { createTestAutoscheduleStore } from "../helpers/application";

describe("workbook boundary", () => {
  it("labels the exported vacancy explanation column without inventing a history column", () => {
    const state = createDefaultState();
    const flight = state.flights[0]!;
    const rule = state.positionRules.find(
      (row) => row.flightNo === flight.flightNo
    )!;
    state.assignments = [
      {
        id: "vacancy",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: null,
        staffName: "",
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        manualRemark: "",
        status: "unfilled",
        systemNotes: ["换人计算达到时间上限；其他岗位保留。"],
      },
    ];
    const workbook = buildScheduleWorkbook(state, "2026-10-15");
    const serialized = XLSX.read(
      XLSX.write(workbook, { type: "array", bookType: "xlsx" }),
      { type: "array" }
    );
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      serialized.Sheets["排班结果"]!,
      { header: 1, defval: "" }
    );
    expect(rows[0]![11]).toBe("系统说明");
    expect(rows[1]![11]).toBe(state.assignments[0]!.systemNotes!.join("；"));
    const history = XLSX.utils.sheet_to_json<unknown[]>(
      buildConfigWorkbook(state).Sheets["历史排班"]!,
      { header: 1, defval: "" }
    );
    expect(history[0]).not.toContain("系统说明");
  });
  it("round-trips current duty and standby roster overrides", () => {
    const state = createDefaultState();
    state.staff[0]!.cxPreflightQualified = true;
    state.dutyRosterOverrides = [
      {
        date: "2026-10-01",
        cxPreflightStaffId: state.staff[0]!.id,
        dutyStaffId: state.staff[1]!.id,
        standbyStaffIds: [state.staff[2]!.id, state.staff[3]!.id],
      },
    ];

    const workbook = buildConfigWorkbook(state);
    expect(workbook.SheetNames).toContain("值班轮值");
    const imported = parseWorkbook(workbook, state.staff);

    expect(imported.dutyRosterOverrides).toEqual(state.dutyRosterOverrides);
  });

  it("rejects invalid duty roster rows without returning partial data", () => {
    const state = createDefaultState();
    const workbook = buildConfigWorkbook(state);
    workbook.Sheets["值班轮值"] = XLSX.utils.aoa_to_sheet([
      ["日期", "CX航前人员编号", "值班人员编号", "备勤1编号", "备勤2编号"],
      [
        "2026-10-01",
        state.staff[0]!.id,
        "missing",
        state.staff[2]!.id,
        state.staff[3]!.id,
      ],
      [
        "2026-10-02",
        state.staff[0]!.id,
        state.staff[1]!.id,
        state.staff[2]!.id,
        state.staff[2]!.id,
      ],
    ]);

    const imported = parseWorkbook(workbook, state.staff);

    expect(imported.dutyRosterOverrides).toBeUndefined();
    expect(imported.warnings).toContain(
      "值班轮值第2行：值班人员编号“missing”不存在"
    );
    expect(imported.warnings).toContain(
      "值班轮值第3行：值班和备勤人员不能重复"
    );
  });

  it("keeps older configuration workbooks without a duty roster sheet compatible", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["编号", "姓名", "状态"],
        ["1", "甲", "正常"],
      ]),
      "人员信息"
    );

    const imported = parseWorkbook(workbook, []);

    expect(imported.dutyRosterOverrides).toBeUndefined();
    expect(imported.warnings).not.toContain("未识别到受支持的工作表");
  });

  it("exports and parses the active group's complete history sheet", () => {
    const state = createDefaultState();
    state.history = [
      {
        id: "history-1",
        date: "2026-09-20",
        flightNo: "CX937",
        position: "G20",
        staffId: "retired-person",
        staffName: "历史人员",
        startTime: "08:00",
        endTime: "10:00",
        flightCutoffTime: "10:30",
        workHours: 0,
        fatiguePoints: 0,
        remark: "岗位原始备注；人工备注",
        historyCoverage: "late-priority-only",
        teamLeaderGapFill: true,
      },
    ];

    const workbook = buildConfigWorkbook(state);
    expect(workbook.SheetNames).toContain("历史排班");
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["历史排班"]!,
      { header: 1, raw: false, defval: "" }
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("retired-person");
    expect(rows[1]).toContain("历史人员");
    expect(rows[1]).toContain("late-priority-only");

    const imported = parseWorkbook(workbook, state.staff);
    expect(imported.history).toHaveLength(1);
    expect(imported.history?.[0]).toMatchObject({
      date: "2026-09-20",
      flightNo: "CX937",
      position: "G20",
      staffId: "retired-person",
      staffName: "历史人员",
      workHours: 0,
      flightCutoffTime: "10:30",
      fatiguePoints: 0,
      remark: "岗位原始备注；人工备注",
      historyCoverage: "late-priority-only",
      teamLeaderGapFill: true,
    });
  });

  it("exports an empty history sheet for a state without history", () => {
    const workbook = buildConfigWorkbook(createDefaultState());
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["历史排班"]!,
      { header: 1, raw: false, defval: "" }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("日期");
  });

  it("exports every registered structured policy sheet", () => {
    const workbook = buildConfigWorkbook(createDefaultState());

    for (const definition of Object.values(STRUCTURED_POLICY_DEFINITIONS)) {
      expect(workbook.SheetNames).toContain(definition.excelSheet);
    }
  });

  it("exports the active group's staff and flights while keeping shared sheets available", () => {
    const initial = createDefaultState();
    initial.history = [
      {
        id: "a-history",
        date: "2026-09-18",
        flightNo: "A-FLIGHT",
        position: "A岗位",
        staffId: initial.staff[0]!.id,
        staffName: initial.staff[0]!.name,
        startTime: "08:00",
        endTime: "09:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "A组历史",
      },
    ];
    initial.groups.B.staff = [
      { ...initial.staff[0]!, id: "b-only", name: "B组人员" },
    ];
    initial.groups.B.history = [
      {
        ...initial.history[0]!,
        id: "b-history",
        flightNo: "B-FLIGHT",
        staffId: "b-only",
        staffName: "B组人员",
        remark: "B组历史",
      },
    ];
    initial.positionRules[0]!.qualifiedStaffIds.push("b-only");
    initial.shared.positionRules[0]!.qualifiedStaffIds.push("b-only");
    initial.groups.B.flights = [
      {
        ...initial.flights[0]!,
        id: "b-flight",
        flightNo: "B-FLIGHT",
      },
    ];
    const store = createTestAutoscheduleStore(initial);
    store.getState().switchGroup("B");

    const workbook = buildConfigWorkbook(store.getState().model);
    const staffSheetName = workbook.SheetNames[0]!;
    const flightSheetName = workbook.SheetNames[1]!;
    const staffRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets[staffSheetName]!,
      { header: 1 }
    );
    const flightRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets[flightSheetName]!,
      { header: 1 }
    );

    expect(staffRows.some((row) => row.includes("b-only"))).toBe(true);
    expect(staffRows.some((row) => row.includes(initial.staff[1]!.id))).toBe(
      false
    );
    expect(flightRows.some((row) => row.includes("B-FLIGHT"))).toBe(true);
    expect(
      flightRows.some((row) => row.includes(initial.flights[1]!.flightNo))
    ).toBe(false);
    const historyRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["历史排班"]!,
      { header: 1 }
    );
    expect(historyRows.some((row) => row.includes("b-history"))).toBe(true);
    expect(historyRows.some((row) => row.includes("a-history"))).toBe(false);
    expect(workbook.SheetNames).toContain("岗位配置");
    const positionRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["岗位配置"]!,
      { header: 1 }
    );
    const qualifiedCells = positionRows
      .slice(1)
      .map((row) => String(row[4] ?? ""));
    expect(
      qualifiedCells.some((cell) => cell.split(",").includes("b-only"))
    ).toBe(true);
    expect(
      qualifiedCells.some((cell) =>
        cell.split(",").includes(initial.staff[0]!.id)
      )
    ).toBe(false);
  });

  it("rejects a same-flight exclusion sheet that references missing staff", () => {
    const state = createDefaultState();
    const workbook = buildConfigWorkbook(state);
    workbook.Sheets["同航班人员互斥"] = XLSX.utils.aoa_to_sheet([
      [
        "规则ID",
        "适用航班（空白表示全部）",
        "人员A编号",
        "人员A姓名",
        "人员B编号",
        "人员B姓名",
      ],
      [
        "bad-pair",
        "KE166",
        state.staff[0]!.id,
        state.staff[0]!.name,
        "missing",
        "不存在",
      ],
    ]);

    const imported = parseWorkbook(workbook, state.staff);

    expect(imported.settings?.sameFlightStaffExclusions).toBeUndefined();
    expect(imported.warnings).toContain(
      "同航班人员互斥第2行：人员B编号“missing”不存在"
    );
  });

  it("round-trips per-row same-flight exclusion state and defaults old sheets to enabled", () => {
    const state = createDefaultState();
    state.settings.sameFlightStaffExclusions = [
      {
        id: "disabled-pair",
        enabled: false,
        firstStaffId: state.staff[0]!.id,
        secondStaffId: state.staff[1]!.id,
        flightNo: "KE166",
      },
    ];
    const exported = buildConfigWorkbook(state);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      exported.Sheets["同航班人员互斥"]!,
      { header: 1, raw: false, defval: "" }
    );

    expect(rows[0]).toContain("启用");
    expect(
      parseWorkbook(exported, state.staff).settings?.sameFlightStaffExclusions
    ).toEqual(state.settings.sameFlightStaffExclusions);

    const legacy = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      legacy,
      XLSX.utils.aoa_to_sheet([
        [
          "规则ID",
          "适用航班（空白表示全部）",
          "人员A编号",
          "人员A姓名",
          "人员B编号",
          "人员B姓名",
        ],
        [
          "legacy-pair",
          "KE166",
          state.staff[0]!.id,
          state.staff[0]!.name,
          state.staff[1]!.id,
          state.staff[1]!.name,
        ],
      ]),
      "同航班人员互斥"
    );

    expect(
      parseWorkbook(legacy, state.staff).settings?.sameFlightStaffExclusions
    ).toEqual([
      {
        id: "legacy-pair",
        enabled: true,
        firstStaffId: state.staff[0]!.id,
        secondStaffId: state.staff[1]!.id,
        flightNo: "KE166",
      },
    ]);

    const invalid = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      invalid,
      XLSX.utils.aoa_to_sheet([
        [
          "规则ID",
          "适用航班（空白表示全部）",
          "人员A编号",
          "人员A姓名",
          "人员B编号",
          "人员B姓名",
          "启用",
        ],
        [
          "invalid-pair",
          "KE166",
          state.staff[0]!.id,
          state.staff[0]!.name,
          state.staff[1]!.id,
          state.staff[1]!.name,
          "未知",
        ],
      ]),
      "同航班人员互斥"
    );
    const rejected = parseWorkbook(invalid, state.staff);

    expect(rejected.settings?.sameFlightStaffExclusions).toBeUndefined();
    expect(rejected.warnings).toContain(
      "同航班人员互斥第2行：启用必须填写是或否"
    );
  });
  it("round-trips manual late-priority frequency corrections by flight and category", () => {
    const state = createDefaultState();
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId: state.staff[0]!.id,
        flightNo: "TR121",
        kind: "number-one",
        delta: -2,
        resetBaseline: 2,
      },
    ];
    const workbook = buildConfigWorkbook(state);
    expect(workbook.SheetNames).toContain("末班重点次数修正");
    expect(
      parseWorkbook(workbook, state.staff).latePriorityFrequencyAdjustments
    ).toEqual(state.latePriorityFrequencyAdjustments);
  });

  it("maps workbook rows into stable domain models", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["编号", "姓名", "是否可上夜班", "状态", "备注"],
        ["9", "Test", "否", "正常", "R"],
      ]),
      "人员信息"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["航班号", "开始时间", "结束时间", "涉及岗位", "备注"],
        ["AB123", "8:30:00", "10:30", "P1，P2", "R"],
      ]),
      "航班计划"
    );
    const imported = parseWorkbook(workbook, []);
    expect(imported.staff).toEqual([
      {
        id: "9",
        name: "Test",
        staffType: "常规",
        teamLeader: false,
        cxPreflightQualified: false,
        dutyQualified: true,
        standbyQualified: true,
        nightShift: false,
        status: "正常",
        remark: "R",
      },
    ]);
    expect(imported.flights?.[0]).toMatchObject({
      flightNo: "AB123",
      startTime: "08:30",
      endTime: "10:30",
      positions: ["P1", "P2"],
    });
  });

  it("exports both operational and machine-readable schedule views", async () => {
    const state = createDefaultState();
    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;
    const earlyPriority = assignments.find(
      (assignment) =>
        assignment.flightNo === "CX937" && assignment.position === "G20"
    );
    const latePriority = assignments.find(
      (assignment) =>
        assignment.flightNo === "CX931" && assignment.position === "G20"
    );
    expect(earlyPriority).toBeDefined();
    expect(latePriority).toBeDefined();
    latePriority!.staffId = earlyPriority!.staffId;
    latePriority!.staffName = earlyPriority!.staffName;
    assignments[0]!.manualOverrideWarnings = [
      { code: "daily-hours", message: "人员A 将超过每日工时上限" },
    ];
    state.assignments = assignments;
    state.activeScheduleDate = "2026-07-18";
    const workbook = buildScheduleWorkbook(state, "2026-07-18");
    expect(workbook.SheetNames).toHaveLength(3);
    expect(workbook.Sheets[workbook.SheetNames[0]!]!["!ref"]).toBeTruthy();
    expect(workbook.Sheets[workbook.SheetNames[1]!]!["!ref"]).toBeTruthy();
    const machineRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["排班结果"]!,
      { header: 1, raw: false, defval: "" }
    );
    const onePosition = machineRows.find(
      (row) => row[1] === "CX937" && row[2] === "G20"
    );
    expect(onePosition?.[8]).toBe("一号");
    expect(machineRows.flat().join(" ")).toContain(
      "人工调整提醒：人员A 将超过每日工时上限"
    );
    expect(machineRows.flat().join(" ")).toContain("规则提醒：");
    const detailRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["保障明细"]!,
      { header: 1, raw: false, defval: "" }
    );
    const detailText = detailRows.flat().join(" ");
    expect(detailText).toContain("CX航前");
    expect(detailText).toContain("24小时值班");
    expect(detailText).toContain("次日备勤一（2026-07-19）");
    expect(detailText).toContain("引导人员");
    const flightHeader = detailRows
      .flat()
      .find(
        (value): value is string =>
          typeof value === "string" &&
          /^\p{L}{2}\d+\n到岗[^\n]*\n/mu.test(value)
      );
    expect(flightHeader).toBeTruthy();
    const guideRow = detailRows.findIndex((row) => row.includes("引导人员"));
    expect(guideRow).toBeGreaterThan(2);
    expect(detailRows[guideRow - 1]?.every((value) => value === "")).toBe(true);
    expect(detailRows[guideRow - 2]?.every((value) => value === "")).toBe(true);
  }, 30_000);

  it("groups early departures by airline code in the schedule summary", () => {
    const state = createDefaultState();
    const staff = state.staff.slice(0, 2).map((person, index) => ({
      ...person,
      id: `early-${index}`,
      name: index === 0 ? "钱七" : "孙八",
      dutyQualified: false,
      cxPreflightQualified: false,
      standbyQualified: false,
    }));
    state.staff = staff;
    state.positionRules = [];
    state.assignments = staff.map((person, index) => ({
      id: `early-assignment-${index}`,
      flightId: `flight-${index}`,
      flightNo: index === 0 ? "TR999" : "TW888",
      positionRuleId: null,
      position: "普通岗位",
      staffId: person.id,
      staffName: person.name,
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned" as const,
    }));
    state.activeScheduleDate = "2026-07-18";
    state.settings.earlyDepartureCutoffTime = "13:00";

    const workbook = buildScheduleWorkbook(state, "2026-07-18");
    const detailRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["保障明细"]!,
      {
        header: 1,
        raw: false,
        defval: "",
      }
    );
    const earlyRow = detailRows.find((row) => row[0] === "提前下班");
    expect(earlyRow?.[1]).toBe("TR：钱七\nTW：孙八");
    expect(earlyRow?.[1]).not.toContain("TR999");
    expect(earlyRow?.[1]).not.toContain("13:00");
  });

  it("keeps the flight cutoff in a schedule workbook and excludes late-cutoff dates", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    person.dutyQualified = false;
    state.staff = [person];
    state.positionRules = [];
    state.activeScheduleDate = "2026-10-01";
    state.settings.earlyDepartureCutoffTime = "23:30";
    state.flights = [
      {
        id: "flight-AK151",
        flightNo: "AK151",
        startTime: "21:05",
        endTime: "23:05",
        bookedPassengers: 0,
        positions: ["G09"],
        remark: "",
      },
      {
        id: "flight-TGT123",
        flightNo: "TGT123",
        startTime: "22:10",
        endTime: "22:50",
        bookedPassengers: 0,
        positions: ["G01"],
        remark: "",
      },
    ];
    state.assignments = [
      {
        id: "released-ak151",
        flightId: "flight-AK151",
        flightNo: "AK151",
        positionRuleId: null,
        position: "G09",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:05",
        endTime: "22:10",
        workHours: 1.08,
        fatiguePoints: 3.5,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "target-g01",
        flightId: "flight-TGT123",
        flightNo: "TGT123",
        positionRuleId: null,
        position: "G01",
        staffId: person.id,
        staffName: person.name,
        startTime: "22:10",
        endTime: "22:50",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];

    const workbook = buildScheduleWorkbook(state, "2026-10-01");
    const scheduleRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["排班结果"]!,
      { header: 1, raw: false, defval: "" }
    );
    const cutoffColumn = scheduleRows[0]!.indexOf("航班截载时间");
    const akRow = scheduleRows.find((row) => row[1] === "AK151");
    const detailRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["保障明细"]!,
      { header: 1, raw: false, defval: "" }
    );

    expect(akRow?.[cutoffColumn]).toBe("23:05");
    expect(detailRows.find((row) => row[0] === "提前下班")?.[1]).toBe("无");
    expect(parseWorkbook(workbook, state.staff).history?.[0]).toMatchObject({
      endTime: "22:10",
      flightCutoffTime: "23:05",
    });
  });

  it("imports a flight configuration sheet as reusable templates", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["航班号", "开始时间", "结束时间", "涉及岗位", "备注"],
        ["AB123", "08:30", "10:30", "P1,P2", "到岗"],
      ]),
      "航班配置"
    );
    const imported = parseWorkbook(workbook, []);
    expect(imported.templates?.[0]).toMatchObject({
      flightNo: "AB123",
      positions: ["P1", "P2"],
      remark: "到岗",
    });
  });

  it("round-trips flight templates and passenger thresholds in configuration workbooks", () => {
    const state = createDefaultState();
    state.positionRules[0]!.minPassengers = 30;
    state.positionRules[0]!.category = "分流";
    state.positionRules[0]!.earlyReleaseMinutes = 45;
    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);
    expect(imported.templates).toHaveLength(state.templates.length);
    expect(imported.positionRules?.[0]).toMatchObject({
      minPassengers: 30,
      category: "分流",
      earlyReleaseMinutes: 45,
    });
  });

  it("round-trips weekly flight plans and treats an empty sheet as a cleared plan", () => {
    const state = createDefaultState();
    state.weeklyFlightPlans = replaceWeeklyFlightPlan(
      state.weeklyFlightPlans,
      1,
      [state.templates[0]!.flightNo, state.templates[1]!.flightNo]
    );
    state.weeklyFlightPlans = replaceWeeklyFlightPlan(
      state.weeklyFlightPlans,
      7,
      [state.templates[2]!.flightNo]
    );

    const exported = buildConfigWorkbook(state);
    const imported = parseWorkbook(exported, state.staff);

    expect(exported.SheetNames).toContain("每周航班计划");
    expect(imported.weeklyFlightPlans).toEqual(state.weeklyFlightPlans);

    const emptyWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      emptyWorkbook,
      XLSX.utils.aoa_to_sheet([["星期", "航班号（用逗号分隔）"]]),
      "每周航班计划"
    );
    expect(parseWorkbook(emptyWorkbook, state.staff).weeklyFlightPlans).toEqual(
      createDefaultState().weeklyFlightPlans
    );
  });

  it("round-trips cross-flight priority policies", () => {
    const state = createDefaultState();
    state.settings.crossFlightPriorityPolicies = [
      {
        id: "priority-1",
        enabled: true,
        flightNo: "KE166",
        staffIds: state.staff.slice(0, 4).map((person) => person.id),
      },
    ];
    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);
    expect(imported.settings?.crossFlightPriorityPolicies).toEqual(
      state.settings.crossFlightPriorityPolicies
    );
  });

  it("rejects a cross-flight priority sheet with unknown staff ids", () => {
    const state = createDefaultState();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["规则ID", "启用", "优先航班号", "优先人员编号（逗号分隔）"],
        ["priority-1", "是", "KE166", "missing"],
      ]),
      "跨航班重点人员优先"
    );

    const imported = parseWorkbook(workbook, state.staff);

    expect(imported.settings?.crossFlightPriorityPolicies).toBeUndefined();
    expect(imported.warnings).toContain(
      "跨航班重点人员优先第2行：优先人员编号“missing”不存在"
    );
  });

  it("round-trips administrative support position categories", () => {
    const state = createDefaultState();
    state.positionRules[0]!.category = "行政支援";
    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);
    expect(imported.positionRules?.[0]?.category).toBe("行政支援");
  });

  it("round-trips supervisor position categories", () => {
    const state = createDefaultState();
    state.positionRules[0]!.category = "机动督导";
    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);
    expect(imported.positionRules?.[0]?.category).toBe("机动督导");
  });

  it("keeps regular and administrative rules with the same position name", () => {
    const state = createDefaultState();
    const base = state.positionRules[0]!;
    state.positionRules = [
      { ...base, id: "regular", name: "督导", category: "常规" },
      { ...base, id: "admin", name: "督导", category: "行政支援" },
    ];
    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);
    expect(imported.positionRules?.map((rule) => rule.category)).toEqual([
      "常规",
      "行政支援",
    ]);
  });

  it("ignores removed support-category rows", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["航班号", "项目分类", "岗位名称", "备注", "可胜任人员"],
        ["AB123", "支援", "旧支援岗位", "", "手动输入项"],
      ]),
      "岗位配置"
    );
    expect(parseWorkbook(workbook, []).positionRules).toEqual([]);
  });

  it("round-trips administrative support personnel types", () => {
    const state = createDefaultState();
    state.staff[0]!.staffType = "行政支援";
    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);
    expect(imported.staff?.[0]?.staffType).toBe("行政支援");
    expect(imported.staff?.[0]?.standbyQualified).toBe(false);
  });

  it("round-trips the team-leader personnel flag", () => {
    const state = createDefaultState();
    state.staff[0]!.teamLeader = true;

    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);

    expect(imported.staff?.[0]?.teamLeader).toBe(true);
  });

  it("round-trips CX preflight personnel qualifications", () => {
    const state = createDefaultState();
    state.staff[0]!.cxPreflightQualified = true;
    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);
    expect(imported.staff?.[0]?.cxPreflightQualified).toBe(true);
  });

  it("round-trips duty personnel qualifications", () => {
    const state = createDefaultState();
    state.staff[0]!.dutyQualified = false;
    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);
    expect(imported.staff?.[0]?.dutyQualified).toBe(false);
  });

  it("round-trips standby personnel qualifications", () => {
    const state = createDefaultState();
    state.staff[0]!.standbyQualified = false;
    const workbook = buildConfigWorkbook(state);
    const imported = parseWorkbook(workbook, state.staff);
    const headers = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["人员信息"]!,
      { header: 1, raw: false, defval: "" }
    )[0];

    expect(headers).toContain("备勤资质");
    expect(imported.staff?.[0]?.standbyQualified).toBe(false);
  });

  it("ships a downloadable configuration template with current qualification and rule fields", () => {
    const workbook = XLSX.readFile(
      join(process.cwd(), "public", "template", "排班工具配置模板.xlsx")
    );
    const headers = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["人员信息"]!,
      { header: 1, raw: false, defval: "" }
    )[0];

    expect(headers).toContain("备勤资质");
    expect(workbook.SheetNames).toEqual(
      expect.arrayContaining([
        "每周航班计划",
        "岗位衔接规则",
        "值班岗位优先",
        "次班恢复目标",
        "末班重点岗位",
        "机动督导范围",
        "跨工作日资质预留",
        "跨航班重点人员优先",
        "同航班人员互斥",
        "末班重点航班范围",
        "分队长补差保护范围",
      ])
    );
    const settingCodes = XLSX.utils
      .sheet_to_json<unknown[]>(workbook.Sheets["规则参数"]!, {
        header: 1,
        raw: false,
        defval: "",
      })
      .slice(1)
      .map((row) => row[0]);
    expect(settingCodes).toEqual(
      SCHEDULE_SETTING_DEFINITIONS.map((definition) => definition.key)
    );
    const imported = parseWorkbook(workbook, []);
    const defaultState = createDefaultState();
    const { adminSupportEnabled: _adminSupportEnabled, ...defaultSettings } =
      defaultState.settings;
    expect(imported.warnings).toEqual([]);
    expect(imported.settings).toEqual(defaultSettings);
    expect(imported.weeklyFlightPlans).toEqual(defaultState.weeklyFlightPlans);
  });

  it("round-trips every editable scheduling setting and rule table", () => {
    const state = createDefaultState();
    state.settings.dailyFlightCountBalanceExemptHalfRest = false;
    state.settings.dailyFlightCountBalanceExemptTeamLeaders = false;
    state.settings.maxDailyHours = 9.5;
    state.settings.historyWindowDays = 12;
    state.settings.nightStart = "21:30";
    state.settings.nightEnd = "05:30";
    state.settings.dutyFatiguePoints = 7.5;
    state.settings.lateShiftEndTime = "23:30";
    state.settings.nextWorkdayRecoveryMode = "forbid";
    state.settings.teamLeaderConcurrentSupervisionMaxOverlapMinutes = 45;
    state.settings.minimumRegularTransitionMinutes = 90;
    state.settings.earlyDepartureCutoffTime = "11:45";
    state.settings.positionTransitionPolicies = [
      {
        id: "transition-export",
        name: "测试衔接",
        enabled: true,
        sourceFlightNo: "CX937",
        sourcePositions: ["G20", "G19"],
        targetFlightNo: "TR121",
        targetPosition: "H02",
        minimumGapMinutes: 180,
        mode: "forbid",
      },
    ];
    state.settings.dutyPositionPriorities = [
      {
        id: "duty-export",
        flightNo: "TR121",
        positionKeyword: "H02",
        enabled: true,
      },
    ];
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "recovery-export",
        flightNo: "CX937",
        positionKeyword: "控制",
        enabled: true,
      },
    ];
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "late-export",
        enabled: true,
        flightNo: "TR121",
        matchField: "position",
        keyword: "H02",
        nextWorkdayCutoffTime: "14:30",
      },
    ];
    state.settings.mobileSupervisorCoverageRules = [
      {
        id: "supervisor-export",
        enabled: true,
        flightNo: "KE166",
        matchField: "remark",
        keyword: "一号",
        mode: "forbid",
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "supervisor-fill-export",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "机动督导",
        targetFlightNo: "TR121",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: false,
      },
    ];
    state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.name === "H05"
    )!.coverageRole = "supervisor-fill";
    state.settings.crossWorkdayQualificationReservations = [
      {
        id: "reservation-export",
        enabled: true,
        flightNo: "CX931",
        matchField: "remark",
        keyword: "控制",
        minimumStaffCount: 1,
      },
    ];
    state.settings.latePriorityFlightNumbers = ["TR121", "TW616"];
    state.settings.teamLeaderGapFillPositionPolicies = [
      { flightNo: "AK151", position: "引导", movable: true },
      { flightNo: "TR121", position: "H08", movable: false },
    ];
    const workbook = buildConfigWorkbook(state);
    const imported = parseWorkbook(workbook, state.staff);

    expect(workbook.SheetNames).toEqual(
      expect.arrayContaining([
        "规则参数",
        "岗位衔接规则",
        "值班岗位优先",
        "次班恢复目标",
        "末班重点岗位",
        "机动督导范围",
        "督导补位关系",
        "跨工作日资质预留",
        "末班重点航班范围",
        "分队长补差保护范围",
      ])
    );
    expect(workbook.SheetNames).not.toContain("规则执行顺序");
    const { adminSupportEnabled: _adminSupportEnabled, ...exportedSettings } =
      state.settings;
    expect(imported.settings).toEqual(exportedSettings);
    expect(
      imported.positionRules?.find(
        (rule) => rule.flightNo === "TR121" && rule.name === "H05"
      )
    ).toMatchObject({ category: "常规", coverageRole: "supervisor-fill" });
    expect(imported.settings).not.toHaveProperty("adminSupportEnabled");
    expect(workbook.SheetNames).not.toContain("值班备勤表");
  });

  it("defaults missing flight-count exemption rows when importing an older rule sheet", () => {
    const state = createDefaultState();
    state.settings.dailyFlightCountBalanceExemptHalfRest = false;
    state.settings.dailyFlightCountBalanceExemptTeamLeaders = false;
    const workbook = buildConfigWorkbook(state);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets["规则参数"]!,
      { header: 1, raw: false, defval: "" }
    );
    workbook.Sheets["规则参数"] = XLSX.utils.aoa_to_sheet(
      rows.filter(
        (row, index) =>
          index === 0 ||
          ![
            "dailyFlightCountBalanceExemptHalfRest",
            "dailyFlightCountBalanceExemptTeamLeaders",
          ].includes(String(row[0]))
      )
    );

    const imported = parseWorkbook(workbook, state.staff);

    expect(imported.settings?.dailyFlightCountBalanceExemptHalfRest).toBe(true);
    expect(imported.settings?.dailyFlightCountBalanceExemptTeamLeaders).toBe(
      true
    );
  });

  it("rejects an invalid team-leader gap-fill protection sheet without partial import", () => {
    const state = createDefaultState();
    const workbook = buildConfigWorkbook(state);
    workbook.Sheets["分队长补差保护范围"] = XLSX.utils.aoa_to_sheet([
      ["航班号", "岗位名称", "允许参与补差换人"],
      ["AK151", "引导", "是"],
      ["TR121", "H08", "不确定"],
    ]);

    const imported = parseWorkbook(workbook, state.staff);

    expect(
      imported.settings?.teamLeaderGapFillPositionPolicies
    ).toBeUndefined();
    expect(imported.warnings.join("；")).toContain("分队长补差保护范围第3行");
  });

  it("keeps settings absent when importing an older configuration workbook", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["航班号", "开始时间", "结束时间", "涉及岗位", "备注"],
        ["AB123", "08:30", "10:30", "P1", ""],
      ]),
      "航班配置"
    );

    expect(parseWorkbook(workbook, []).settings).toBeUndefined();
  });

  it("treats a present rule sheet with only a header as an explicit clear", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["规则ID", "航班号", "岗位关键词", "启用"]]),
      "值班岗位优先"
    );

    expect(
      parseWorkbook(workbook, []).settings?.dutyPositionPriorities
    ).toEqual([]);
  });

  it("keeps present empty configuration sheets distinguishable from missing sheets", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["编号", "姓名", "是否可上夜班", "状态", "备注"],
      ]),
      "人员信息"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["航班号", "开始时间", "结束时间", "涉及岗位", "备注"],
      ]),
      "航班配置"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["航班号", "项目分类", "岗位名称", "备注", "可胜任人员"],
      ]),
      "岗位配置"
    );

    const imported = parseWorkbook(workbook, createDefaultState().staff);

    expect(imported.staff).toEqual([]);
    expect(imported.templates).toEqual([]);
    expect(imported.positionRules).toEqual([]);
    expect(imported.warnings).toEqual([]);
  });

  it("does not bind imported history to old-device staff after an explicit staff clear", () => {
    const current = createDefaultState();
    const person = current.staff[0]!;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["编号", "姓名", "是否可上夜班", "状态", "备注"],
      ]),
      "人员信息"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["日期", "航班号", "岗位", "姓名", "开始时间", "结束时间"],
        ["2026-08-19", "CX937", "G20", person.name, "08:00", "10:00"],
      ]),
      "历史排班"
    );

    const imported = parseWorkbook(workbook, current.staff);

    expect(imported.staff).toEqual([]);
    expect(imported.history?.[0]?.staffId).toBe("");
  });

  it("rejects one invalid rule sheet without blocking another valid sheet", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["规则ID", "航班号", "岗位关键词", "启用"],
        ["bad-duty", "TR121", "H02", "不确定"],
      ]),
      "值班岗位优先"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["规则ID", "航班号", "岗位关键词", "启用"],
        ["valid-recovery", "CX937", "控制", "是"],
      ]),
      "次班恢复目标"
    );

    const imported = parseWorkbook(workbook, []);

    expect(imported.settings).not.toHaveProperty("dutyPositionPriorities");
    expect(imported.settings?.nextWorkdayRecoveryTargets).toEqual([
      {
        id: "valid-recovery",
        flightNo: "CX937",
        positionKeyword: "控制",
        enabled: true,
      },
    ]);
    expect(imported.warnings.join("\n")).toContain("值班岗位优先第2行");
  });

  it("preserves rule ids and worksheet row order", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["规则ID", "航班号", "岗位关键词", "启用"],
        ["second", "TR121", "送资料", "是"],
        ["first", "TR121", "H02", "否"],
      ]),
      "值班岗位优先"
    );

    expect(
      parseWorkbook(workbook, []).settings?.dutyPositionPriorities
    ).toEqual([
      {
        id: "second",
        flightNo: "TR121",
        positionKeyword: "送资料",
        enabled: true,
      },
      {
        id: "first",
        flightNo: "TR121",
        positionKeyword: "H02",
        enabled: false,
      },
    ]);
  });

  it("exports manually entered names and cell remarks in the horizontal detail", async () => {
    const state = createDefaultState();
    state.flights = [state.flights[0]!];
    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;
    const flight = state.flights[0]!;
    const manualRule = state.positionRules.find(
      (item) => item.flightNo === flight.flightNo && item.name === "超规柜台"
    )!;
    assignments.push({
      id: "manual",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: manualRule.id,
      position: manualRule.name,
      staffId: null,
      staffName: "临时人员",
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 2,
      fatiguePoints: manualRule.fatiguePoints,
      remark: manualRule.remark,
      manualRemark: "09:00-10:00",
      status: "assigned",
    });
    state.assignments = assignments;
    state.activeScheduleDate = "2026-07-18";
    const workbook = buildScheduleWorkbook(state, "2026-07-18");
    const detail = XLSX.utils
      .sheet_to_json<unknown[]>(workbook.Sheets["保障明细"]!, {
        header: 1,
        raw: false,
        defval: "",
      })
      .flat();
    expect(detail).toContain("临时人员\n09:00-10:00");
  });
});

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";

import { createDefaultState } from "../../src/defaults";
import type { HistoryRecord } from "../../src/model";
import type { DutyRosterImportPreview } from "../../src/infrastructure/duty-roster-excel";
import {
  applyDutyRosterImport,
  applyWorkbookImport,
  validateDutyRosterImport,
} from "../../src/app/workbook-actions";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import { historyFatigue } from "../../src/domain/statistics/fatigue";
import { samePositionFrequencyProfile } from "../../src/domain/statistics/schedule-frequency";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";

describe("workbook actions", () => {
  it("restores exported duty roster overrides without reordering them", () => {
    const source = createDefaultState();
    source.staff[0]!.cxPreflightQualified = true;
    source.staff[1]!.cxPreflightQualified = true;
    source.dutyRosterOverrides = [
      {
        date: "2026-10-01",
        cxPreflightStaffId: source.staff[0]!.id,
        dutyStaffId: source.staff[1]!.id,
        standbyStaffIds: [source.staff[2]!.id, source.staff[3]!.id],
      },
      {
        date: "2026-10-03",
        cxPreflightStaffId: source.staff[1]!.id,
        dutyStaffId: source.staff[0]!.id,
        standbyStaffIds: [source.staff[3]!.id, source.staff[2]!.id],
      },
    ];
    const target = createDefaultState();
    const imported = parseWorkbook(
      XLSX.read(
        XLSX.write(buildConfigWorkbook(source), {
          bookType: "xlsx",
          type: "buffer",
        }),
        { type: "buffer" }
      ),
      target.staff
    );

    const result = applyWorkbookImport(target, imported, "config");

    expect(result.errors).toBeUndefined();
    expect(target.dutyRosterOverrides).toEqual(source.dutyRosterOverrides);
  });

  it("does not partially apply configuration when duty roster validation fails", () => {
    const target = createDefaultState();
    const originalStaff = structuredClone(target.staff);
    const originalTemplates = structuredClone(target.templates);
    const imported = {
      ...parseWorkbook(
        XLSX.read(
          XLSX.write(buildConfigWorkbook(target), {
            bookType: "xlsx",
            type: "buffer",
          }),
          { type: "buffer" }
        ),
        target.staff
      ),
      staff: [{ ...target.staff[0]!, name: "不应写入" }],
      dutyRosterInvalid: true,
    };

    const result = applyWorkbookImport(target, imported, "config");

    expect(result.errors).toEqual([
      "值班轮值工作表存在错误，未写入任何值班轮值数据",
    ]);
    expect(target.staff).toEqual(originalStaff);
    expect(target.templates).toEqual(originalTemplates);
  });

  it("restores every exported long-term configuration on a fresh device", () => {
    const source = createDefaultState();
    source.settings.adminSupportEnabled = true;
    source.settings.maxDailyHours = 9.5;
    source.settings.nextWorkdayRecoveryMode = "forbid";
    source.settings.positionTransitionPolicies[0]!.mode = "forbid";
    source.settings.positionTransitionPolicies[0]!.minimumGapMinutes = 240;
    source.settings.crossFlightPriorityPolicies = [
      {
        id: "imported-priority",
        enabled: false,
        flightNo: "KE166",
        staffIds: source.staff.slice(0, 2).map((person) => person.id),
      },
    ];
    source.settings.sameFlightStaffExclusions = [
      {
        id: "same-flight-pair",
        enabled: false,
        firstStaffId: source.staff[0]!.id,
        secondStaffId: source.staff[1]!.id,
        flightNo: "KE166",
      },
      {
        id: "all-flight-pair",
        enabled: true,
        firstStaffId: source.staff[2]!.id,
        secondStaffId: source.staff[3]!.id,
        flightNo: "",
      },
    ];
    source.settings.teamLeaderGapFillPositionPolicies = [
      {
        flightNo: source.positionRules[0]!.flightNo,
        position: source.positionRules[0]!.name,
        movable: true,
      },
    ];
    source.staff[0]!.standbyQualified = false;
    source.positionRules[0]!.fatiguePoints = 9;
    source.weeklyFlightPlans = replaceWeeklyFlightPlan(
      source.weeklyFlightPlans,
      1,
      [source.templates[0]!.flightNo]
    );
    source.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId: source.staff[0]!.id,
        flightNo: "TR121",
        kind: "supervisor",
        delta: 2,
      },
    ];

    const target = createDefaultState();
    const preservedAdminMode = target.settings.adminSupportEnabled;
    target.dutyRosterOverrides = [
      {
        date: "2026-08-01",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    const exportedBytes = XLSX.write(buildConfigWorkbook(source), {
      bookType: "xlsx",
      type: "buffer",
    });
    const imported = parseWorkbook(
      XLSX.read(exportedBytes, { type: "buffer" }),
      target.staff
    );

    applyWorkbookImport(target, imported, "config");

    const { adminSupportEnabled: _sourceAdminMode, ...sourceSettings } =
      source.settings;
    const { adminSupportEnabled: targetAdminMode, ...targetSettings } =
      target.settings;
    expect(targetSettings).toEqual(sourceSettings);
    expect(targetAdminMode).toBe(preservedAdminMode);
    expect(target.staff).toEqual(source.staff);
    expect(target.latePriorityFrequencyAdjustments).toEqual(
      source.latePriorityFrequencyAdjustments
    );
    expect(target.templates).toEqual(imported.templates);
    expect(target.positionRules).toEqual(imported.positionRules);
    expect(target.weeklyFlightPlans).toEqual(source.weeklyFlightPlans);
    expect(target.dutyRosterOverrides).toEqual(source.dutyRosterOverrides);
    expect(target.settings.positionTransitionPolicies[0]!.mode).toBe("forbid");
    expect(target.settings.sameFlightStaffExclusions).toEqual(
      source.settings.sameFlightStaffExclusions
    );
  });

  it("applies recognized empty configuration sheets as explicit clears", () => {
    const state = createDefaultState();
    const importedFlight = {
      ...state.flights[0]!,
      id: "imported-flight",
      flightNo: "ONLY100",
    };

    const result = applyWorkbookImport(
      state,
      {
        staff: [],
        flights: [importedFlight],
        templates: [],
        positionRules: [],
        warnings: [],
      },
      "config"
    );

    expect(result.changedConfig).toBe(true);
    expect(result.recognized).toContain("0 人");
    expect(result.recognized).toContain("0 个航班模板");
    expect(result.recognized).toContain("0 条岗位规则");
    expect(state.staff).toEqual([]);
    expect(state.templates).toEqual([]);
    expect(state.positionRules).toEqual([]);
    expect(state.flights).not.toEqual([importedFlight]);
  });

  it("replaces an imported weekly plan, filters missing templates, and preserves it when omitted", () => {
    const state = createDefaultState();
    state.weeklyFlightPlans = replaceWeeklyFlightPlan(
      state.weeklyFlightPlans,
      1,
      [state.templates[0]!.flightNo]
    );
    const preserved = structuredClone(state.weeklyFlightPlans);

    applyWorkbookImport(state, { warnings: [] }, "config");
    expect(state.weeklyFlightPlans).toEqual(preserved);

    const importedPlan = replaceWeeklyFlightPlan(
      createDefaultState().weeklyFlightPlans,
      2,
      [state.templates[1]!.flightNo, "MISSING100"]
    );
    const result = applyWorkbookImport(
      state,
      { weeklyFlightPlans: importedPlan, warnings: [] },
      "config"
    );

    expect(
      state.weeklyFlightPlans.find((entry) => entry.weekday === 1)?.flightNos
    ).toEqual([]);
    expect(
      state.weeklyFlightPlans.find((entry) => entry.weekday === 2)?.flightNos
    ).toEqual([state.templates[1]!.flightNo]);
    expect(result).toEqual({
      changedConfig: true,
      recognized: "每周航班计划",
    });
  });

  it("applies a mixed import, clears the active schedule, and reports recognized data", () => {
    const state = createDefaultState();
    const flight = {
      ...state.flights[0]!,
      id: "imported-flight",
      flightNo: "NEW100",
    };
    const person = {
      ...state.staff[0]!,
      id: "imported-staff",
      name: "导入人员",
    };
    state.assignments = [
      {
        id: "assignment",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: null,
        position: "临时岗位",
        staffId: null,
        staffName: "",
        startTime: "08:00",
        endTime: "09:00",
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
        manualRemark: "",
        status: "manual",
      },
    ];
    state.activeScheduleDate = "2026-07-25";
    state.schedulePolicyStale = true;

    const result = applyWorkbookImport(
      state,
      { staff: [person], flights: [flight], warnings: [] },
      "all"
    );
    expect(result).toMatchObject({ changedConfig: true });
    expect(result.recognized).toContain("1 人");
    expect(state.staff).toEqual([person]);
    expect(state.flights).toEqual([flight]);
    expect(state.assignments).toEqual([]);
    expect(state.activeScheduleDate).toBeNull();
    expect(state.schedulePolicyStale).toBe(false);
  });

  it("keeps configuration untouched in history-only mode and replaces duplicate history keys", () => {
    const state = createDefaultState();
    const originalStaff = structuredClone(state.staff);
    const history = {
      id: "incoming",
      date: "2026-07-23",
      flightNo: "CX937",
      position: "G20",
      staffId: "2",
      staffName: "华嘉慧",
      startTime: "08:30",
      endTime: "10:30",
      workHours: 2,
      fatiguePoints: 4,
      remark: "",
    } satisfies HistoryRecord;
    state.history = [{ ...history, id: "old" }];

    applyWorkbookImport(
      state,
      { staff: [], history: [history], warnings: [] },
      "history"
    );
    expect(state.staff).toEqual(originalStaff);
    expect(state.history).toEqual([history]);
  });

  it("imports configuration history as statistical facts without current qualification checks", () => {
    const state = createDefaultState();
    const originalAssignments = [
      {
        id: "active-assignment",
        flightId: state.flights[0]!.id,
        flightNo: state.flights[0]!.flightNo,
        positionRuleId: state.positionRules[0]!.id,
        position: state.positionRules[0]!.name,
        staffId: state.staff[0]!.id,
        staffName: state.staff[0]!.name,
        startTime: state.flights[0]!.startTime,
        endTime: state.flights[0]!.endTime,
        workHours: 1,
        fatiguePoints: 1,
        remark: "当前未归档班表",
        manualRemark: "",
        status: "assigned" as const,
      },
    ];
    state.assignments = originalAssignments;
    state.activeScheduleDate = "2026-09-26";
    const history = {
      id: "incoming-history",
      date: "2026-09-20",
      flightNo: state.flights[0]!.flightNo,
      position: state.positionRules[0]!.name,
      staffId: state.staff[0]!.id,
      staffName: state.staff[0]!.name,
      startTime: state.flights[0]!.startTime,
      endTime: state.flights[0]!.endTime,
      workHours: 2,
      fatiguePoints: 4,
      remark: "旧历史事实",
    } satisfies HistoryRecord;
    state.positionRules[0]!.qualifiedStaffIds =
      state.positionRules[0]!.qualifiedStaffIds.filter(
        (staffId) => staffId !== history.staffId
      );

    const result = applyWorkbookImport(
      state,
      { history: [history], warnings: [] },
      "config"
    );

    expect(result.recognized).toContain("1 条历史负荷");
    expect(state.history).toEqual([history]);
    expect(state.assignments).toEqual(originalAssignments);
    expect(state.activeScheduleDate).toBe("2026-09-26");
    expect(
      samePositionFrequencyProfile(
        state,
        history.staffId,
        history.flightNo,
        history.position,
        history.remark,
        "2026-09-26"
      )
    ).toEqual({ currentMonthCount: 1, recentWorkdayCount: 1 });
    expect(
      historyFatigue(
        state.history,
        history.staffId,
        "2026-09-26",
        state.settings
      )
    ).toBe(4);
  });

  it("uses imported staff when previewing unmatched history on a fresh device", () => {
    const state = createDefaultState();
    const importedPerson = { ...state.staff[0]!, id: "new-device-person" };
    const history = {
      id: "new-device-history",
      date: "2026-09-20",
      flightNo: "CX937",
      position: "G20",
      staffId: importedPerson.id,
      staffName: importedPerson.name,
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 2,
      remark: "",
    } satisfies HistoryRecord;

    const result = applyWorkbookImport(
      state,
      { staff: [importedPerson], history: [history], warnings: [] },
      "config"
    );

    expect(result.historySummary).toEqual({
      total: 1,
      added: 1,
      replaced: 0,
      unmatchedStaff: 0,
    });
  });

  it("removes manual standby overrides invalidated by an imported qualification", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    state.dutyRosterOverrides = [
      {
        date: "2026-08-01",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [person.id, null],
      },
    ];
    const importedStaff = state.staff.map((item) =>
      item.id === person.id ? { ...item, standbyQualified: false } : item
    );

    applyWorkbookImport(
      state,
      { staff: importedStaff, warnings: [] },
      "config"
    );

    expect(state.dutyRosterOverrides).toEqual([]);
  });

  it("rejects staff ids already owned by the other group before changing the active group", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    state.groups.B.staff = [{ ...person, name: "B组同编号人员" }];
    const originalStaff = structuredClone(state.staff);

    const result = applyWorkbookImport(
      state,
      { staff: [{ ...person, name: "导入A组人员" }], warnings: [] },
      "config"
    );

    expect(result.changedConfig).toBe(false);
    expect(result.rejected).toBe(1);
    expect(result.errors?.join(" ")).toContain(person.id);
    expect(state.staff).toEqual(originalStaff);
  });

  it("preserves the other group's qualifications when importing shared position rules", () => {
    const state = createDefaultState();
    const currentId = state.staff[0]!.id;
    const otherId = "B-qualified";
    state.groups.B.staff = [
      { ...state.staff[1]!, id: otherId, name: "B组资质人员" },
    ];
    const existing = state.positionRules[0]!;
    existing.qualifiedStaffIds = [currentId, otherId];
    const importedRule = {
      ...existing,
      id: "imported-rule",
      qualifiedStaffIds: [state.staff[1]!.id],
    };

    applyWorkbookImport(
      state,
      { positionRules: [importedRule], warnings: [] },
      "config"
    );

    expect(state.positionRules[0]!.qualifiedStaffIds).toEqual([
      otherId,
      state.staff[1]!.id,
    ]);
  });

  it("preserves the other group's personnel rules when importing shared settings", () => {
    const state = createDefaultState();
    const otherA = { ...state.staff[0]!, id: "B-1", name: "B组一" };
    const otherB = { ...state.staff[1]!, id: "B-2", name: "B组二" };
    state.groups.B.staff = [otherA, otherB];
    const otherRule = {
      id: "b-pair",
      enabled: false,
      flightNo: "KE166",
      firstStaffId: otherA.id,
      secondStaffId: otherB.id,
    };
    state.settings.sameFlightStaffExclusions = [otherRule];
    const currentRule = {
      id: "a-pair",
      enabled: true,
      flightNo: "CX937",
      firstStaffId: state.staff[0]!.id,
      secondStaffId: state.staff[1]!.id,
    };

    applyWorkbookImport(
      state,
      {
        settings: { sameFlightStaffExclusions: [currentRule] },
        warnings: [],
      },
      "config"
    );

    expect(state.settings.sameFlightStaffExclusions).toEqual([
      otherRule,
      currentRule,
    ]);
  });

  it("preserves the other group's selected people when importing cross-flight priority rows", () => {
    const state = createDefaultState();
    const otherId = "B-priority";
    state.groups.B.staff = [
      { ...state.staff[0]!, id: otherId, name: "B组重点人员" },
    ];
    state.settings.crossFlightPriorityPolicies = [
      {
        id: "priority-1",
        enabled: true,
        flightNo: "KE166",
        staffIds: [state.staff[0]!.id, otherId],
      },
    ];

    applyWorkbookImport(
      state,
      {
        settings: {
          crossFlightPriorityPolicies: [
            {
              id: "priority-1",
              enabled: true,
              flightNo: "KE166",
              staffIds: [state.staff[1]!.id],
            },
          ],
        },
        warnings: [],
      },
      "config"
    );

    expect(state.settings.crossFlightPriorityPolicies[0]!.staffIds).toEqual([
      otherId,
      state.staff[1]!.id,
    ]);

    applyWorkbookImport(
      state,
      {
        settings: { crossFlightPriorityPolicies: [] },
        warnings: [],
      },
      "config"
    );
    expect(state.settings.crossFlightPriorityPolicies).toEqual([
      {
        id: "priority-1",
        enabled: true,
        flightNo: "KE166",
        staffIds: [otherId],
      },
    ]);
  });

  it("merges imported rule settings, preserves omitted settings, and clears the active schedule", () => {
    const state = createDefaultState();
    const originalAdminMode = state.settings.adminSupportEnabled;
    const originalHighLoadThreshold = state.settings.highLoadFatigueThreshold;
    state.assignments = [
      {
        id: "assignment",
        flightId: "flight",
        flightNo: "F1",
        positionRuleId: null,
        position: "临时岗位",
        staffId: null,
        staffName: "",
        startTime: "08:00",
        endTime: "09:00",
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
        manualRemark: "",
        status: "manual",
      },
    ];
    state.activeScheduleDate = "2026-07-25";

    const result = applyWorkbookImport(
      state,
      {
        settings: {
          dutyFatiguePoints: 6,
          dutyPositionPriorities: [],
        },
        warnings: [],
      },
      "config"
    );

    expect(result).toEqual({ changedConfig: true, recognized: "规则配置" });
    expect(state.settings.dutyFatiguePoints).toBe(6);
    expect(state.settings.dutyPositionPriorities).toEqual([]);
    expect(state.settings.highLoadFatigueThreshold).toBe(
      originalHighLoadThreshold
    );
    expect(state.settings.adminSupportEnabled).toBe(originalAdminMode);
    expect(state.assignments).toEqual([]);
    expect(state.activeScheduleDate).toBeNull();
  });

  it("replaces one month's duty and next-day standby while preserving CX preflight", () => {
    const state = createDefaultState();
    const current = state.staff[0]!;
    current.cxPreflightQualified = true;
    state.dutyRosterOverrides = [
      {
        date: "2026-07-01",
        cxPreflightStaffId: current.id,
        dutyStaffId: state.staff[1]!.id,
        standbyStaffIds: [state.staff[2]!.id, state.staff[3]!.id],
      },
      {
        date: "2026-08-01",
        cxPreflightStaffId: null,
        dutyStaffId: state.staff[1]!.id,
        standbyStaffIds: [state.staff[2]!.id, state.staff[3]!.id],
      },
    ];
    const preview: DutyRosterImportPreview = {
      month: "2026-07",
      referenceDate: "2026-07-01",
      recognizedAssignments: 3,
      canApply: true,
      warnings: [],
      errors: [],
      rows: [
        {
          date: "2026-07-01",
          standbyDate: "2026-07-02",
          dutyStaffId: state.staff[4]!.id,
          standbyStaffIds: [state.staff[5]!.id, state.staff[6]!.id],
        },
      ],
    };

    const result = applyDutyRosterImport(state, preview);

    expect(result).toEqual({ importedDays: 1, importedAssignments: 3 });
    expect(
      state.dutyRosterOverrides.find((row) => row.date === "2026-07-01")
    ).toEqual({
      date: "2026-07-01",
      cxPreflightStaffId: current.id,
      dutyStaffId: state.staff[4]!.id,
      standbyStaffIds: [state.staff[5]!.id, state.staff[6]!.id],
    });
    expect(
      state.dutyRosterOverrides.some((row) => row.date === "2026-08-01")
    ).toBe(true);
  });

  it("allows an imported duty person who is already the preserved CX preflight person", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    person.cxPreflightQualified = true;
    state.dutyRosterOverrides = [
      {
        date: "2026-07-01",
        cxPreflightStaffId: person.id,
        dutyStaffId: state.staff[1]!.id,
        standbyStaffIds: [state.staff[2]!.id, state.staff[3]!.id],
      },
    ];
    const preview: DutyRosterImportPreview = {
      month: "2026-07",
      referenceDate: "2026-07-01",
      recognizedAssignments: 3,
      canApply: true,
      warnings: [],
      errors: [],
      rows: [
        {
          date: "2026-07-01",
          standbyDate: "2026-07-02",
          dutyStaffId: person.id,
          standbyStaffIds: [state.staff[4]!.id, state.staff[5]!.id],
        },
      ],
    };

    const validated = validateDutyRosterImport(preview);

    expect(validated.canApply).toBe(true);
    expect(validated.errors).not.toContain(
      "2026-07-01的值班人员同时承担CX航前，请先调整其中一个安排"
    );
    expect(applyDutyRosterImport(state, preview)).toEqual({
      importedDays: 1,
      importedAssignments: 3,
    });
    expect(state.dutyRosterOverrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: "2026-07-01",
          cxPreflightStaffId: person.id,
          dutyStaffId: person.id,
        }),
      ])
    );
  });

  it("preserves duty when a new month's first-day standby only covers the previous workday", () => {
    const state = createDefaultState();
    const existing = {
      date: "2026-07-31",
      cxPreflightStaffId: null,
      dutyStaffId: state.staff[0]!.id,
      standbyStaffIds: [state.staff[1]!.id, state.staff[2]!.id] as [
        string,
        string,
      ],
    };
    state.dutyRosterOverrides = [existing];
    const preview: DutyRosterImportPreview = {
      month: "2026-08",
      referenceDate: "2026-08-02",
      recognizedAssignments: 2,
      canApply: true,
      warnings: [],
      errors: [],
      rows: [
        {
          date: "2026-07-31",
          standbyDate: "2026-08-01",
          dutyStaffId: null,
          standbyStaffIds: [state.staff[3]!.id, state.staff[4]!.id],
          dutyIncluded: false,
          standbyIncluded: true,
        },
      ],
    };

    applyDutyRosterImport(state, preview);

    expect(state.dutyRosterOverrides[0]).toMatchObject({
      dutyStaffId: existing.dutyStaffId,
      standbyStaffIds: [state.staff[3]!.id, state.staff[4]!.id],
    });
  });
});

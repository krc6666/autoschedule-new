import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { assignStaff } from "../../src/app/schedule-actions";
import {
  buildHistoricalScheduleDraft,
  currentScheduleHistory,
  replaceHistoryForDate,
} from "../../src/app/history-actions";
import { buildOrdinaryPriorityStatistics } from "../../src/domain/statistics/ordinary-priority-statistics";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";
import { updateOrdinaryPriorityFrequencyAdjustment } from "../../src/app/statistics-actions";
import { loadState, saveState } from "../../src/infrastructure/storage";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import {
  createMemoryStatePersistence,
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import { diagnoseBaseAssignmentEligibility } from "../../src/domain/candidates/assignment-eligibility";
import {
  resetMonthlyLatePriorityFrequencyCounts,
  updateLatePriorityFrequencyAdjustment,
  applyLatePriorityCountsImport,
} from "../../src/app/statistics-actions";
import {
  buildLatePriorityCountsWorkbook,
  parseLatePriorityCountsWorkbook,
} from "../../src/infrastructure/late-priority-counts-excel";
import {
  createScheduleFrequencyFacts,
  positionFrequencyProfileForRule,
} from "../../src/domain/statistics/schedule-frequency";
import { latePriorityFrequencyProfileForRule } from "../../src/domain/statistics/late-priority-frequency";
import { recentArchivedWorkdays } from "../../src/domain/statistics/fatigue";
import * as XLSX from "xlsx-js-style";

function scenario() {
  const state = createDefaultState();
  const people = state.staff
    .filter((p) => p.staffType === "常规" && p.status === "正常")
    .slice(0, 3);
  people.forEach((p, index) => {
    p.nightShift = true;
    p.teamLeader = false;
    p.name = `Test worker ${index + 1}`;
  });
  state.staff = people;
  state.activeScheduleDate = "2026-10-09";
  state.settings.dutyFatiguePoints = 0;
  state.settings.ordinaryPriorityPositions = [
    { airlineCode: "FD", position: "G07" },
  ];
  state.settings.latePriorityFlightNumbers = ["FD573"];
  state.flights = [
    {
      id: "flight",
      flightNo: "FD573",
      startTime: "22:00",
      endTime: "23:55",
      positions: ["G07"],
      bookedPassengers: 0,
      remark: "",
    },
  ];
  state.templates = state.flights.map((f) => ({ ...f }));
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "rule",
      flightNo: "FD573",
      name: "G07",
      remark: "一号",
      category: "常规",
      qualifiedStaffIds: [people[0]!.id],
      manual: false,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    },
  ];
  state.assignments = [
    {
      id: "slot",
      flightId: "flight",
      flightNo: "FD573",
      positionRuleId: "rule",
      position: "G07",
      staffId: people[0]!.id,
      staffName: people[0]!.name,
      startTime: "22:00",
      endTime: "23:55",
      workHours: 1.92,
      fatiguePoints: 5,
      remark: "一号",
      manualRemark: "",
      status: "assigned",
    },
  ];
  state.history = [];
  state.ordinaryPriorityFrequencyAdjustments = [];
  state.latePriorityFrequencyAdjustments = [];
  return { state, people };
}

describe("manual qualification override history contract", () => {
  it("deduplicates qualification overrides with the same late count dimension", () => {
    const { state, people } = scenario();
    assignStaff(state, "slot", people[1]!.id);
    const record = currentScheduleHistory(state, "2026-10-09")[0]!;
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "duplicate-category",
      name: "G08",
    });
    state.history = [record, { ...record, id: "other-role", position: "G08" }];
    state.assignments = [];
    const row = buildMonthlyLatePriorityStatistics(
      state,
      "2026-10-15"
    ).rows.find((r) => r.staff.id === people[1]!.id)!;
    expect(row.totalCount).toBe(1);
    expect(row.qualificationOverrideCount).toBe(1);
  });
  it("does not turn a cleared count baseline into a worked day for rotation or recovery", () => {
    const { state } = scenario();
    const actual = { ...currentScheduleHistory(state, "2026-10-07")[0]! };
    assignStaff(state, "slot", "");
    state.history = [actual, ...currentScheduleHistory(state, "2026-10-09")];
    expect(
      recentArchivedWorkdays(state.history, "2026-10-11", 1).map((r) => r.date)
    ).toEqual(["2026-10-07"]);
  });
  it("keeps swap baselines on both slots and automatic fairness counts only the final workers", () => {
    const { state, people } = scenario();
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "second-rule",
      name: "G08",
      remark: "申报",
      qualifiedStaffIds: [people[1]!.id],
    });
    state.assignments.push({
      ...state.assignments[0]!,
      id: "second-slot",
      positionRuleId: "second-rule",
      position: "G08",
      remark: "申报",
      staffId: people[1]!.id,
      staffName: people[1]!.name,
    });
    state.flights[0]!.positions.push("G08");
    expect(
      assignStaff(state, "slot", people[1]!.id, "second-slot").changed
    ).toBe(true);
    expect(state.assignments).toMatchObject([
      { staffId: people[1]!.id, countBaseline: { staffId: people[0]!.id } },
      { staffId: people[0]!.id, countBaseline: { staffId: people[1]!.id } },
    ]);
    state.history = currentScheduleHistory(state, "2026-10-09");
    const facts = createScheduleFrequencyFacts(state, "2026-10-11");
    expect(
      positionFrequencyProfileForRule(
        state,
        people[0]!.id,
        "FD573",
        state.positionRules[0]!,
        "2026-10-11",
        facts
      ).currentMonthCount
    ).toBe(0);
    expect(
      positionFrequencyProfileForRule(
        state,
        people[1]!.id,
        "FD573",
        state.positionRules[0]!,
        "2026-10-11",
        facts
      ).currentMonthCount
    ).toBe(1);
    expect(
      latePriorityFrequencyProfileForRule(
        state,
        people[1]!.id,
        state.flights[0]!,
        state.positionRules[0]!,
        "2026-10-11",
        facts
      ).counts["number-one"].currentMonthCount
    ).toBe(1);
  });

  it("does not infer an old qualification breach or manual source from today's configuration", () => {
    const { state, people } = scenario();
    state.history = [
      {
        ...currentScheduleHistory(state, "2026-10-09")[0]!,
        staffId: people[1]!.id,
        staffName: people[1]!.name,
      },
    ];
    state.assignments = [];
    expect(
      buildOrdinaryPriorityStatistics(state, "2026-10-15").find(
        (r) => r.staff.id === people[1]!.id
      )
    ).toMatchObject({
      actualCount: 1,
      manualCorrection: 0,
      effectiveCount: 1,
      qualificationOverrideCount: 0,
      qualificationUnrecordedCount: 1,
    });
    expect(
      buildMonthlyLatePriorityStatistics(state, "2026-10-15").rows.find(
        (r) => r.staff.id === people[1]!.id
      )
    ).toMatchObject({
      totalCount: 1,
      qualificationOverrideCount: 0,
      qualificationUnrecordedCount: 1,
    });
  });
  it("persists actual manual edits through archive and historical save commands, isolates groups and cancels edits", async () => {
    const { state, people } = scenario();
    const persistence = createMemoryStatePersistence();
    const app = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state, persistence),
      {
        confirm: () => true,
        preferences: {
          loadScheduleDate: () => "2026-10-09",
          saveScheduleDate: () => {},
          loadScheduleZoom: () => null,
          saveScheduleZoom: () => {},
        },
      }
    );
    await app.handle({
      type: "update-assignment",
      id: "slot",
      field: "staffName",
      value: people[1]!.name,
    });
    expect(persistence.load().assignments[0]).toMatchObject({
      staffId: people[1]!.id,
      countBaseline: { staffId: people[0]!.id },
    });
    await app.handle({ type: "archive-schedule" });
    await app.handle({ type: "archive-schedule" });
    expect(app.model().history).toHaveLength(1);
    const archived = structuredClone(app.model().history);
    await app.handle({ type: "switch-group", groupId: "B" });
    expect(app.model().history).not.toEqual(archived);
    await app.handle({ type: "switch-group", groupId: "A" });
    expect(app.model().history).toEqual(archived);
    const originalAssignments = structuredClone(app.model().assignments);
    await app.handle({ type: "edit-history-date", date: "2026-10-09" });
    await app.handle({
      type: "update-assignment",
      id: app.model().assignments[0]!.id,
      field: "staffName",
      value: people[2]!.name,
    });
    await app.handle({ type: "cancel-history-edit" });
    expect(app.model().history).toEqual(archived);
    expect(app.model().assignments).toEqual(originalAssignments);
    await app.handle({ type: "edit-history-date", date: "2026-10-09" });
    await app.handle({
      type: "update-assignment",
      id: app.model().assignments[0]!.id,
      field: "staffName",
      value: people[2]!.name,
    });
    await app.handle({ type: "save-history-edit" });
    expect(app.view().historyEditDate).toBeNull();
    expect(persistence.load().history[0]).toMatchObject({
      staffId: people[2]!.id,
      countBaseline: { staffId: people[0]!.id },
      manualOverrideWarnings: expect.arrayContaining([
        expect.objectContaining({ code: "position-qualification" }),
      ]),
    });
    expect(app.model().assignments).toEqual(originalAssignments);
  });

  it("automatically merges a historical qualification override into existing corrections and the current schedule", async () => {
    const { state, people } = scenario();
    state.history = currentScheduleHistory(state, "2026-10-09");
    state.activeScheduleDate = "2026-10-11";
    const currentAssignments = structuredClone(state.assignments);
    const persistence = createMemoryStatePersistence();
    const app = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state, persistence),
      {
        confirm: () => true,
        preferences: {
          loadScheduleDate: () => "2026-10-11",
          saveScheduleDate: () => {},
          loadScheduleZoom: () => null,
          saveScheduleZoom: () => {},
        },
      }
    );
    await app.handle({ type: "edit-history-date", date: "2026-10-09" });
    await app.handle({
      type: "update-assignment",
      id: app.model().assignments[0]!.id,
      field: "staffName",
      value: people[1]!.name,
    });
    await app.handle({ type: "save-history-edit" });
    expect(app.model().assignments).toEqual(currentAssignments);
    expect(persistence.load().history[0]).toMatchObject({
      staffId: people[1]!.id,
      countBaseline: { staffId: people[0]!.id },
      manualOverrideWarnings: expect.arrayContaining([
        expect.objectContaining({ code: "position-qualification" }),
      ]),
    });
    const counts = (snapshot: typeof state, staffId: string) => {
      const ordinary = buildOrdinaryPriorityStatistics(
        snapshot,
        "2026-10-11"
      ).find((row) => row.staff.id === staffId)!;
      const late = buildMonthlyLatePriorityStatistics(
        snapshot,
        "2026-10-11"
      ).rows.find((row) => row.staff.id === staffId)!.flights.FD573!.categories
        .一号;
      return [
        [
          ordinary.actualCount,
          ordinary.manualCorrection,
          ordinary.effectiveCount,
        ],
        [late.baseCount, late.manualCorrection, late.effectiveCount],
      ];
    };
    // Two generated dates for A, with only the historical date transferred to B.
    expect(counts(app.model(), people[0]!.id)).toEqual([
      [2, -1, 1],
      [2, -1, 1],
    ]);
    expect(counts(app.model(), people[1]!.id)).toEqual([
      [0, 1, 1],
      [0, 1, 1],
    ]);
    await app.handle({ type: "edit-history-date", date: "2026-10-09" });
    await app.handle({ type: "save-history-edit" });
    expect(counts(persistence.load(), people[1]!.id)).toEqual([
      [0, 1, 1],
      [0, 1, 1],
    ]);
    await app.handle({
      type: "adjust-ordinary-priority-frequency",
      month: "2026-10",
      staffId: people[1]!.id,
      airlineCode: "FD",
      position: "G07",
      delta: 1,
    });
    await app.handle({
      type: "adjust-late-priority-frequency",
      month: "2026-10",
      staffId: people[1]!.id,
      flightNo: "FD573",
      kind: "number-one",
      delta: 1,
    });
    expect(counts(persistence.load(), people[1]!.id)).toEqual([
      [0, 2, 2],
      [0, 2, 2],
    ]);
  });

  it("keeps automatic qualification strict after a successful manual override", () => {
    const { state, people } = scenario();
    expect(assignStaff(state, "slot", people[1]!.id).changed).toBe(true);
    expect(
      diagnoseBaseAssignmentEligibility(
        state,
        state.flights[0]!,
        state.positionRules[0]!,
        people[1]!
      ).eligible
    ).toBe(false);
    expect(state.positionRules[0]!.qualifiedStaffIds).toEqual([people[0]!.id]);
  });

  it("preserves late counts import and reset without adding manual differences twice", () => {
    const { state, people } = scenario();
    assignStaff(state, "slot", people[1]!.id);
    state.history = currentScheduleHistory(state, "2026-10-09");
    state.assignments = [];
    state.activeScheduleDate = null;
    const preview = parseLatePriorityCountsWorkbook(
      buildLatePriorityCountsWorkbook(state, "2026-10-15"),
      state,
      "2026-10-15"
    );
    expect(preview.errors).toEqual([]);
    expect(preview.canApply).toBe(true);
    expect(applyLatePriorityCountsImport(state, preview)).toBe(false);
    expect(resetMonthlyLatePriorityFrequencyCounts(state, "2026-10-15")).toBe(
      true
    );
    const count = () =>
      buildMonthlyLatePriorityStatistics(state, "2026-10-15").rows.find(
        (r) => r.staff.id === people[1]!.id
      )!.flights.FD573!.categories.一号.effectiveCount;
    expect(count()).toBe(0);
    expect(
      updateLatePriorityFrequencyAdjustment(
        state,
        "2026-10",
        people[1]!.id,
        "FD573",
        "number-one",
        -1
      )
    ).toBe(false);
    expect(
      updateLatePriorityFrequencyAdjustment(
        state,
        "2026-10",
        people[1]!.id,
        "FD573",
        "number-one",
        1
      )
    ).toBe(true);
    expect(count()).toBe(1);
    expect(
      updateLatePriorityFrequencyAdjustment(
        state,
        "2026-10",
        people[1]!.id,
        "FD573",
        "number-one",
        -100
      )
    ).toBe(true);
    expect(count()).toBe(0);
    expect(
      updateLatePriorityFrequencyAdjustment(
        state,
        "2026-10",
        people[1]!.id,
        "FD573",
        "number-one",
        1
      )
    ).toBe(true);
    expect(count()).toBe(1);
  });
  it("saves an unqualified manual replacement, reloads evidence, and derives corrections once", () => {
    const { state, people } = scenario();
    expect(assignStaff(state, "slot", people[1]!.id).changed).toBe(true);
    const archive = currentScheduleHistory(state, "2026-10-09");
    expect(archive[0]).toMatchObject({
      staffId: people[1]!.id,
      countBaseline: { staffId: people[0]!.id },
      manualOverrideWarnings: expect.arrayContaining([
        expect.objectContaining({ code: "position-qualification" }),
      ]),
    });
    replaceHistoryForDate(state, "2026-10-09", archive);
    const draft = buildHistoricalScheduleDraft(state, "2026-10-09");
    expect(draft.warnings).toEqual([]);
    expect(draft.assignments[0]).toMatchObject({
      staffId: people[1]!.id,
      countBaseline: { staffId: people[0]!.id },
      manualOverrideWarnings: archive[0]!.manualOverrideWarnings,
    });
    state.flights = draft.flights;
    state.assignments = draft.assignments;
    expect(currentScheduleHistory(state, "2026-10-09")[0]?.remark).toBe(
      archive[0]?.remark
    );
    replaceHistoryForDate(
      state,
      "2026-10-09",
      currentScheduleHistory(state, "2026-10-09")
    );
    for (const date of ["2026-10-09", "2026-10-15"]) {
      const rows = buildOrdinaryPriorityStatistics(state, date);
      expect(rows.find((r) => r.staff.id === people[0]!.id)).toMatchObject({
        actualCount: 1,
        manualCorrection: -1,
        effectiveCount: 0,
      });
      expect(rows.find((r) => r.staff.id === people[1]!.id)).toMatchObject({
        actualCount: 0,
        manualCorrection: 1,
        effectiveCount: 1,
        qualificationOverrideCount: 1,
      });
      const late = buildMonthlyLatePriorityStatistics(state, date).rows;
      expect(
        late.find((r) => r.staff.id === people[0]!.id)?.flights.FD573
          ?.categories.一号
      ).toMatchObject({
        baseCount: 1,
        manualCorrection: -1,
        effectiveCount: 0,
      });
      expect(
        late.find((r) => r.staff.id === people[1]!.id)?.flights.FD573
          ?.categories.一号
      ).toMatchObject({ baseCount: 0, manualCorrection: 1, effectiveCount: 1 });
    }
    const originalQualification = [
      ...state.positionRules[0]!.qualifiedStaffIds,
    ];
    expect(
      assignStaff(state, state.assignments[0]!.id, people[2]!.id).changed
    ).toBe(true);
    expect(state.assignments[0]!.countBaseline?.staffId).toBe(people[0]!.id);
    expect(state.positionRules[0]!.qualifiedStaffIds).toEqual(
      originalQualification
    );
  });

  it("preserves cleared baseline without workload and round trips storage and both Excel exports", () => {
    const { state, people } = scenario();
    assignStaff(state, "slot", people[1]!.id);
    for (const workbook of [
      buildScheduleWorkbook(state, "2026-10-09"),
      buildConfigWorkbook({
        ...state,
        history: currentScheduleHistory(state, "2026-10-09"),
      }),
    ]) {
      const restored = XLSX.read(
        XLSX.write(workbook, { type: "array", bookType: "xlsx" }),
        { type: "array" }
      );
      expect(parseWorkbook(restored, state.staff).history?.[0]).toMatchObject({
        staffId: people[1]!.id,
        countBaseline: { staffId: people[0]!.id },
        manualOverrideWarnings: expect.arrayContaining([
          expect.objectContaining({ code: "position-qualification" }),
        ]),
      });
    }
    assignStaff(state, "slot", "");
    state.history = currentScheduleHistory(state, "2026-10-09");
    expect(state.history).toMatchObject([
      {
        staffId: "",
        staffName: "",
        workHours: 0,
        fatiguePoints: 0,
        countBaseline: { staffId: people[0]!.id },
      },
    ]);
    let serialized = "";
    saveState(state, {
      setItem: (_key, value) => {
        serialized = value;
      },
    });
    const loaded = loadState({ getItem: () => serialized });
    expect(loaded.history[0]?.countBaseline).toEqual(
      state.history[0]?.countBaseline
    );
    expect(
      parseWorkbook(buildConfigWorkbook(state), state.staff).history
    ).toMatchObject([
      { staffId: "", countBaseline: { staffId: people[0]!.id } },
    ]);
    expect(
      buildOrdinaryPriorityStatistics(loaded, "2026-10-15").find(
        (r) => r.staff.id === people[0]!.id
      )
    ).toMatchObject({
      actualCount: 1,
      manualCorrection: -1,
      effectiveCount: 0,
    });
    const draft = buildHistoricalScheduleDraft(loaded, "2026-10-09");
    loaded.assignments = draft.assignments;
    loaded.flights = draft.flights;
    expect(
      assignStaff(loaded, loaded.assignments[0]!.id, people[1]!.id).changed
    ).toBe(true);
    expect(
      currentScheduleHistory(loaded, "2026-10-09")[0]?.workHours
    ).toBeGreaterThan(0);
  });

  it("stops decrementing at zero without hidden debt and does not relax hard blockers", () => {
    const { state, people } = scenario();
    const adjust = (n: number) =>
      updateOrdinaryPriorityFrequencyAdjustment(
        state,
        "2026-10",
        people[1]!.id,
        "FD",
        "G07",
        n
      );
    expect(adjust(-1)).toBe(false);
    expect(adjust(1)).toBe(true);
    expect(adjust(-100)).toBe(true);
    expect(adjust(1)).toBe(true);
    expect(
      buildOrdinaryPriorityStatistics(state, "2026-10-09").find(
        (r) => r.staff.id === people[1]!.id
      )?.effectiveCount
    ).toBe(1);
    people[1]!.status = "病假";
    const before = structuredClone(state.assignments);
    expect(assignStaff(state, "slot", people[1]!.id).changed).toBe(false);
    expect(state.assignments).toEqual(before);
  });
});

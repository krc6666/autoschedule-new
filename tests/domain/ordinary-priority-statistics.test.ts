import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { buildOrdinaryPriorityStatistics } from "../../src/domain/statistics/ordinary-priority-statistics";

describe("ordinary priority statistics", () => {
  it.each(["常规", "机动督导", "分流", "引导", "行政支援"] as const)(
    "counts the configured supervisor independently of category %s",
    (category) => {
      const state = createDefaultState();
      const staff = state.staff.find(
        (person) => person.staffType === "常规" && person.status === "正常"
      )!;
      const supervisorRule = state.positionRules.find(
        (rule) => rule.flightNo === "TR121" && rule.name === "督导"
      )!;
      state.staff = [staff];
      state.settings.ordinaryPriorityPositions = [
        { airlineCode: "TR", position: "督导" },
      ];
      state.positionRules = [
        {
          ...supervisorRule,
          category,
          qualifiedStaffIds: [staff.id],
        },
      ];
      state.history = [
        {
          id: "history-tr121-supervisor",
          date: "2026-07-16",
          flightNo: "TR121",
          position: "督导",
          staffId: staff.id,
          staffName: staff.name,
          startTime: "21:00",
          endTime: "23:00",
          workHours: 2,
          fatiguePoints: 9.5,
          remark: "",
        },
      ];

      const row = buildOrdinaryPriorityStatistics(state, "2026-07-18")[0]!;

      expect(row.qualified).toBe(true);
      expect(row.actualCount).toBe(1);
      expect(row.effectiveCount).toBe(1);
      state.history = [];
      const empty = buildOrdinaryPriorityStatistics(state, "2026-07-18")[0]!;
      expect(empty.qualified).toBe(true);
      expect(empty.effectiveCount).toBe(0);
    }
  );

  it("keeps a mobile H02 in its configured position without turning it into a supervisor", () => {
    const state = createDefaultState();
    const staff = state.staff.find(
      (person) => person.staffType === "常规" && person.status === "正常"
    )!;
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.name === "H02"
    )!;
    state.staff = [staff];
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "TR", position: "H02" },
      { airlineCode: "TR", position: "督导" },
    ];
    state.positionRules = [
      { ...rule, category: "机动督导", qualifiedStaffIds: [staff.id] },
    ];

    const rows = buildOrdinaryPriorityStatistics(state, "2026-07-18");
    expect(rows[0]!.qualified).toBe(true);
    expect(rows[1]!.qualified).toBe(false);
  });

  it.each(["常规", "机动督导", "分流", "行政支援"] as const)(
    "counts history and current configured positions in category %s",
    (category) => {
      const state = createDefaultState();
      const staff = state.staff.find(
        (person) => person.staffType === "常规" && person.status === "正常"
      )!;
      const baseRule = state.positionRules[0]!;
      state.staff = [staff];
      state.settings.ordinaryPriorityPositions = [
        { airlineCode: "AK", position: "G08" },
      ];
      state.positionRules = [
        {
          ...baseRule,
          id: "ak151-g08",
          flightNo: "AK151",
          name: "G08",
          category,
          qualifiedStaffIds: [staff.id],
        },
      ];
      state.history = [
        {
          id: "history-ak151-g08",
          date: "2026-07-16",
          flightNo: "AK151",
          position: "G08",
          staffId: staff.id,
          staffName: staff.name,
          startTime: "08:00",
          endTime: "10:00",
          workHours: 2,
          fatiguePoints: 5,
          remark: "",
        },
      ];
      state.activeScheduleDate = "2026-07-18";
      state.assignments = [
        {
          id: "assignment-ak151-g08",
          flightId: "flight-ak151",
          flightNo: "AK151",
          positionRuleId: "ak151-g08",
          position: "G08",
          staffId: staff.id,
          staffName: staff.name,
          startTime: "08:00",
          endTime: "10:00",
          workHours: 2,
          fatiguePoints: 5,
          remark: "",
          manualRemark: "",
          status: "assigned",
        },
      ];

      const row = buildOrdinaryPriorityStatistics(state, "2026-07-18")[0]!;

      expect(row).toMatchObject({
        qualified: true,
        actualCount: 2,
        effectiveCount: 2,
      });
    }
  );

  it("uses the union of matching position-rule qualifications across flights", () => {
    const state = createDefaultState();
    const staff = state.staff
      .filter(
        (person) => person.staffType === "常规" && person.status === "正常"
      )
      .slice(0, 3);
    const baseRule = state.positionRules[0]!;
    state.staff = staff;
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "AK", position: "G08" },
    ];
    state.positionRules = [
      {
        ...baseRule,
        id: "ak151-g08",
        flightNo: "AK151",
        name: "G08",
        category: "常规",
        qualifiedStaffIds: [staff[0]!.id],
      },
      {
        ...baseRule,
        id: "ak152-g08",
        flightNo: "AK152",
        name: " G08 ",
        category: "常规",
        qualifiedStaffIds: [staff[1]!.id],
      },
    ];

    const rows = buildOrdinaryPriorityStatistics(state, "2026-07-18");

    expect(rows.map((row) => [row.staff.id, row.qualified])).toEqual([
      [staff[0]!.id, true],
      [staff[1]!.id, true],
      [staff[2]!.id, false],
    ]);
  });
});

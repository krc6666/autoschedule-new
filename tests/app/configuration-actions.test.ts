import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import {
  applyFlightPlanReconciliation,
  addAdministrativeStaff,
  addFlightsFromTemplates,
  addStaff,
  copyPositionRules,
  deletePosition,
  deleteTemplate,
  deleteStaff,
  saveQualified,
  setWeeklyFlightPlanFlight,
  updateConfigurationField,
} from "../../src/app/configuration-actions";
import { flightNumbersForDate } from "../../src/domain/flights/weekly-flight-plan";
import { activeFlightPositions } from "../../src/domain/flights/schedule-position-rules";
import { buildFlightPlanReconciliation } from "../../src/domain/flights/flight-plan-reconciliation";
import type { OnlineFlightQueryResult } from "../../src/infrastructure/flight-query";

describe("configuration actions", () => {
  it("keeps team-leader gap-fill position references synchronized on rename and delete", () => {
    const state = createDefaultState();
    const rule = state.positionRules[0]!;
    state.settings.teamLeaderGapFillPositionPolicies = [
      { flightNo: rule.flightNo, position: rule.name, movable: true },
    ];

    expect(
      updateConfigurationField(state, "position", rule.id, "name", "新岗位名")
    ).toBe("updated");
    expect(state.settings.teamLeaderGapFillPositionPolicies).toEqual([
      { flightNo: rule.flightNo, position: "新岗位名", movable: true },
    ]);

    expect(deletePosition(state, rule.id)).toBe(true);
    expect(state.settings.teamLeaderGapFillPositionPolicies).toEqual([]);
  });

  it("updates only the selected weekday and keeps template references synchronized", () => {
    const state = createDefaultState();
    const template = state.templates[0]!;
    const originalFlightNo = template.flightNo;

    expect(setWeeklyFlightPlanFlight(state, 1, originalFlightNo, true)).toBe(
      true
    );
    expect(flightNumbersForDate(state.weeklyFlightPlans, "2026-08-17")).toEqual(
      [originalFlightNo]
    );
    expect(flightNumbersForDate(state.weeklyFlightPlans, "2026-08-18")).toEqual(
      []
    );

    expect(
      updateConfigurationField(
        state,
        "template",
        template.id,
        "flightNo",
        "NEW937"
      )
    ).toBe("updated");
    expect(flightNumbersForDate(state.weeklyFlightPlans, "2026-08-17")).toEqual(
      ["NEW937"]
    );

    deleteTemplate(state, template.id);
    expect(flightNumbersForDate(state.weeklyFlightPlans, "2026-08-17")).toEqual(
      []
    );
  });

  it("renames matching position rules together with a flight template", () => {
    const state = createDefaultState();
    const template = state.templates[0]!;
    const rules = state.positionRules.filter(
      (rule) => rule.flightNo === template.flightNo
    );
    expect(rules.length).toBeGreaterThan(0);
    state.activeScheduleDate = "2026-08-17";
    state.schedulePolicyStale = true;

    expect(
      updateConfigurationField(
        state,
        "template",
        template.id,
        "flightNo",
        "cx937(早)"
      )
    ).toBe("updated");

    expect(
      state.positionRules.find((rule) => rule.id === rules[0]!.id)
    ).toMatchObject({
      flightNo: "CX937(早)",
    });
    expect(state.positionRules.some((rule) => rule.flightNo === "CX937")).toBe(
      false
    );
    expect(state.activeScheduleDate).toBeNull();
    expect(state.schedulePolicyStale).toBe(false);
  });

  it("adds new template positions to both groups without sharing rule settings", () => {
    const state = createDefaultState();
    const template = state.templates[0]!;
    const staffIdA = state.groups.A.staff[0]!.id;
    const ruleA = {
      ...state.positionRules[0]!,
      id: "a-h1",
      flightNo: template.flightNo,
      name: "H1",
      category: "分流" as const,
      qualifiedStaffIds: [staffIdA],
      earlyReleaseMinutes: 60,
    };
    const ruleB = {
      ...state.groups.B.positionRules[0]!,
      id: "b-h1",
      flightNo: template.flightNo,
      name: "H1",
      category: "常规" as const,
      qualifiedStaffIds: ["b-only"],
    };
    state.groups.A.positionRules = [ruleA];
    state.groups.B.positionRules = [ruleB];
    state.positionRules = state.groups.A.positionRules;
    state.activeScheduleDate = "2026-08-17";
    state.groups.A.activeScheduleDate = "2026-08-17";
    state.groups.B.activeScheduleDate = "2026-08-17";

    expect(
      updateConfigurationField(
        state,
        "template",
        template.id,
        "positions",
        "H1, H2"
      )
    ).toBe("updated");

    expect(state.groups.A.positionRules).toHaveLength(2);
    expect(state.groups.B.positionRules).toHaveLength(2);
    expect(
      state.groups.A.positionRules.find((rule) => rule.name === "H1")
    ).toMatchObject({
      category: "分流",
      qualifiedStaffIds: [staffIdA],
    });
    expect(
      state.groups.B.positionRules.find((rule) => rule.name === "H1")
    ).toMatchObject({
      category: "常规",
      qualifiedStaffIds: ["b-only"],
    });
    expect(
      state.groups.A.positionRules.find((rule) => rule.name === "H2")
    ).toMatchObject({
      flightNo: template.flightNo,
      category: "常规",
      qualifiedStaffIds: [],
    });
    expect(
      state.groups.B.positionRules.find((rule) => rule.name === "H2")
    ).toMatchObject({
      flightNo: template.flightNo,
      category: "常规",
      qualifiedStaffIds: [],
    });
    const flight = { ...state.flights[0]!, flightNo: template.flightNo };
    expect(
      activeFlightPositions(
        {
          positionRules: state.groups.A.positionRules,
          settings: state.groups.A.settings,
        },
        flight
      )
    ).toContain("H2");
    expect(
      activeFlightPositions(
        {
          positionRules: state.groups.B.positionRules,
          settings: state.groups.B.settings,
        },
        flight
      )
    ).toContain("H2");
    expect(state.activeScheduleDate).toBeNull();
    expect(state.groups.B.activeScheduleDate).toBeNull();

    updateConfigurationField(state, "template", template.id, "positions", "H1");
    expect(state.groups.A.positionRules.map((rule) => rule.name)).toContain(
      "H2"
    );
    expect(state.groups.B.positionRules.map((rule) => rule.name)).toContain(
      "H2"
    );
  });

  it("copies a complete position group and qualifications to another flight", () => {
    const state = createDefaultState();
    const source = "CX937";
    const target = "CX937(晚)";
    const sourceRules = state.positionRules.filter(
      (rule) => rule.flightNo === source
    );

    expect(copyPositionRules(state, source, target, true)).toBe(true);

    const copiedRules = state.positionRules.filter(
      (rule) => rule.flightNo === target
    );
    expect(copiedRules).toHaveLength(sourceRules.length);
    expect(
      copiedRules.map(({ id: _id, flightNo: _flightNo, ...rule }) => rule)
    ).toEqual(
      sourceRules.map(({ id: _id, flightNo: _flightNo, ...rule }) => rule)
    );
    expect(
      copiedRules.every((rule, index) => rule.id !== sourceRules[index]!.id)
    ).toBe(true);
  });

  it("does not overwrite an existing target position group without confirmation", () => {
    const state = createDefaultState();
    const source = "CX937";
    const target = "FD573";
    const before = structuredClone(
      state.positionRules.filter((rule) => rule.flightNo === target)
    );

    expect(copyPositionRules(state, source, target)).toBe(false);
    expect(
      state.positionRules.filter((rule) => rule.flightNo === target)
    ).toEqual(before);
  });

  it("defaults standby qualification by staff type and clears it for administrative support", () => {
    const state = createDefaultState();

    addStaff(state);
    expect(state.staff.at(-1)).toMatchObject({
      staffType: "常规",
      standbyQualified: true,
    });

    addAdministrativeStaff(state);
    expect(state.staff.at(-1)).toMatchObject({
      staffType: "行政支援",
      standbyQualified: false,
    });

    const regular = state.staff[0]!;
    regular.standbyQualified = true;
    state.dutyRosterOverrides = [
      {
        date: "2026-08-01",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [regular.id, null],
      },
    ];
    expect(
      updateConfigurationField(
        state,
        "staff",
        regular.id,
        "staffType",
        "行政支援"
      )
    ).toBe("updated");
    expect(regular.standbyQualified).toBe(false);
    expect(state.dutyRosterOverrides).toEqual([]);
  });

  it("rejects a staff id that belongs to the other group", () => {
    const state = createDefaultState();
    const current = state.staff[0]!;
    state.groups.B.staff = [{ ...current, id: "B-1", name: "B组人员" }];

    expect(
      updateConfigurationField(state, "staff", current.id, "id", "B-1")
    ).toBe("duplicate");
    expect(current.id).not.toBe("B-1");
  });

  it("allocates new staff ids without colliding with the other group", () => {
    const state = createDefaultState();
    state.groups.B.staff = [
      { ...state.staff[0]!, id: "19", name: "B组常规人员" },
      { ...state.staff[0]!, id: "A1", name: "B组行政支援" },
    ];

    addStaff(state);
    addAdministrativeStaff(state);

    expect(state.staff.at(-2)?.id).toBe("20");
    expect(state.staff.at(-1)?.id).toBe("A2");
  });

  it("updates qualifications only in the active group's position rules", () => {
    const state = createDefaultState();
    const rule = state.positionRules[0]!;
    const otherGroupId = "B-qualified";
    state.groups.B.staff = [
      { ...state.staff[0]!, id: otherGroupId, name: "B组资质人员" },
    ];
    state.groups.B.positionRules[0]!.qualifiedStaffIds = [otherGroupId];
    rule.qualifiedStaffIds = [state.staff[0]!.id, otherGroupId];

    expect(saveQualified(state, rule.id, false, [state.staff[1]!.id])).toBe(
      true
    );
    expect(rule.qualifiedStaffIds).toEqual([state.staff[1]!.id]);
    expect(state.groups.B.positionRules[0]!.qualifiedStaffIds).toEqual([
      otherGroupId,
    ]);
  });

  it("applies a flight template and invalidates the active schedule", () => {
    const state = createDefaultState();
    const flight = state.flights[0]!;
    const template = state.templates[1]!;
    state.assignments = [
      {
        id: "assignment",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: null,
        position: "临时岗位",
        staffId: null,
        staffName: "",
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
        manualRemark: "",
        status: "manual",
      },
    ];
    state.activeScheduleDate = "2026-07-25";
    state.schedulePolicyStale = true;

    expect(
      updateConfigurationField(
        state,
        "flight",
        flight.id,
        "flightNo",
        template.flightNo.toLowerCase()
      )
    ).toBe("updated");
    expect(flight).toMatchObject({
      flightNo: template.flightNo,
      startTime: template.startTime,
      endTime: template.endTime,
      positions: template.positions,
    });
    expect(state.assignments).toEqual([]);
    expect(state.activeScheduleDate).toBeNull();
    expect(state.schedulePolicyStale).toBe(false);
  });

  it("keeps mobile-supervisor positions automatic and removes a deleted staff member from references", () => {
    const state = createDefaultState();
    const rule = state.positionRules[0]!;
    const person = state.staff.find((item) =>
      rule.qualifiedStaffIds.includes(item.id)
    )!;
    rule.manual = true;

    expect(
      updateConfigurationField(
        state,
        "position",
        rule.id,
        "category",
        "机动督导"
      )
    ).toBe("updated");
    expect(rule.manual).toBe(false);
    expect(deleteStaff(state, person.id)).toBe(true);
    expect(state.staff.some((item) => item.id === person.id)).toBe(false);
    expect(
      state.positionRules.every(
        (item) => !item.qualifiedStaffIds.includes(person.id)
      )
    ).toBe(true);
  });

  it("adds selected online-query templates without duplicating or overwriting existing flights", () => {
    const state = createDefaultState();
    const [existingTemplate, newTemplate] = state.templates;
    state.flights = [
      {
        ...structuredClone(existingTemplate!),
        id: "existing",
        bookedPassengers: 88,
      },
    ];
    state.assignments = [
      {
        id: "assignment",
        flightId: "existing",
        flightNo: existingTemplate!.flightNo,
        positionRuleId: null,
        position: "临时岗位",
        staffId: null,
        staffName: "",
        startTime: existingTemplate!.startTime,
        endTime: existingTemplate!.endTime,
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
        manualRemark: "",
        status: "manual",
      },
    ];
    state.activeScheduleDate = "2026-07-27";

    const result = addFlightsFromTemplates(state, [
      existingTemplate!.id,
      newTemplate!.id,
      newTemplate!.id,
    ]);

    expect(result).toEqual({ added: 1, skipped: 2 });
    expect(
      state.flights.find((flight) => flight.id === "existing")?.bookedPassengers
    ).toBe(88);
    expect(
      state.flights.filter(
        (flight) => flight.flightNo === newTemplate!.flightNo
      )
    ).toHaveLength(1);
    expect(state.assignments).toEqual([]);
    expect(state.activeScheduleDate).toBeNull();
  });

  it("atomically applies selected additions and confirmed removals", () => {
    const state = createDefaultState();
    const [retainedTemplate, addedTemplate, removedTemplate] = state.templates;
    state.flights = [
      {
        ...structuredClone(retainedTemplate!),
        id: "retained",
        bookedPassengers: 88,
        remark: "人工备注",
      },
      {
        ...structuredClone(removedTemplate!),
        id: "removed",
        bookedPassengers: 66,
      },
    ];
    state.assignments = [
      {
        id: "assignment",
        flightId: "retained",
        flightNo: retainedTemplate!.flightNo,
        positionRuleId: null,
        position: "临时岗位",
        staffId: null,
        staffName: "",
        startTime: retainedTemplate!.startTime,
        endTime: retainedTemplate!.endTime,
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
        manualRemark: "",
        status: "manual",
      },
    ];
    state.activeScheduleDate = "2026-07-27";
    const query: OnlineFlightQueryResult = {
      date: "2026-07-27",
      nextDate: "2026-07-28",
      fetchedAt: "2026-07-26T05:49:13.434Z",
      sourceUrls: [],
      flights: [retainedTemplate!, addedTemplate!].map((template, index) => ({
        key: String(index),
        date: "2026-07-27",
        flightNo: template.flightNo,
        departureTime: "10:00",
        destination: "ICN",
        destinationCity: "Seoul",
        country: "韩国",
        countryCode: "KR",
      })),
    };
    const reconciliation = buildFlightPlanReconciliation(
      state,
      "2026-07-27",
      query
    );

    const result = applyFlightPlanReconciliation(
      state,
      reconciliation,
      [addedTemplate!.id],
      ["removed"]
    );

    expect(result).toEqual({ added: 1, removed: 1, skipped: 0 });
    expect(state.flights.map((flight) => flight.flightNo)).toEqual([
      retainedTemplate!.flightNo,
      addedTemplate!.flightNo,
    ]);
    expect(state.flights[0]).toMatchObject({
      id: "retained",
      bookedPassengers: 88,
      remark: "人工备注",
    });
    expect(state.assignments).toEqual([]);
    expect(state.activeScheduleDate).toBeNull();
  });

  it("does not remove flights when reconciliation removal is blocked", () => {
    const state = createDefaultState();
    const query: OnlineFlightQueryResult = {
      date: "2026-07-28",
      nextDate: "2026-07-29",
      fetchedAt: "2026-07-26T05:49:13.434Z",
      sourceUrls: [],
      flights: [],
    };
    const reconciliation = buildFlightPlanReconciliation(
      state,
      "2026-07-27",
      query
    );
    const flightIds = state.flights.map((flight) => flight.id);

    const result = applyFlightPlanReconciliation(
      state,
      reconciliation,
      [],
      flightIds
    );

    expect(result.removed).toBe(0);
    expect(state.flights.map((flight) => flight.id)).toEqual(flightIds);
  });

  it("keeps same-flight exclusion flight scope synchronized when a template is renamed", () => {
    const state = createDefaultState();
    const template = state.templates[0]!;
    const [first, second] = state.staff;
    state.settings.sameFlightStaffExclusions = [
      {
        id: "exclusion-1",
        enabled: true,
        firstStaffId: first!.id,
        secondStaffId: second!.id,
        flightNo: template.flightNo,
      },
    ];
    state.groups.B.settings.sameFlightStaffExclusions = structuredClone(
      state.settings.sameFlightStaffExclusions
    );
    state.groups.B.positionRules[0]!.flightNo = template.flightNo;

    expect(
      updateConfigurationField(
        state,
        "template",
        template.id,
        "flightNo",
        "NEW937"
      )
    ).toBe("updated");
    expect(state.settings.sameFlightStaffExclusions[0]!.flightNo).toBe(
      "NEW937"
    );
    expect(state.groups.B.settings.sameFlightStaffExclusions[0]!.flightNo).toBe(
      "NEW937"
    );
    expect(state.groups.B.positionRules[0]!.flightNo).toBe("NEW937");
  });

  it("keeps same-flight exclusion people synchronized when a staff id is renamed", () => {
    const state = createDefaultState();
    const [first, second] = state.staff;
    state.settings.sameFlightStaffExclusions = [
      {
        id: "exclusion-1",
        enabled: true,
        firstStaffId: first!.id,
        secondStaffId: second!.id,
        flightNo: "",
      },
    ];

    expect(
      updateConfigurationField(state, "staff", first!.id, "id", "RENAMED")
    ).toBe("updated");
    expect(state.settings.sameFlightStaffExclusions[0]).toMatchObject({
      firstStaffId: "RENAMED",
      secondStaffId: second!.id,
    });
  });

  it("removes same-flight exclusions that reference a deleted staff member", () => {
    const state = createDefaultState();
    const [first, second, third] = state.staff;
    state.settings.sameFlightStaffExclusions = [
      {
        id: "remove-me",
        enabled: true,
        firstStaffId: first!.id,
        secondStaffId: second!.id,
        flightNo: "",
      },
      {
        id: "keep-me",
        enabled: false,
        firstStaffId: second!.id,
        secondStaffId: third!.id,
        flightNo: "",
      },
    ];

    expect(deleteStaff(state, first!.id)).toBe(true);
    expect(state.settings.sameFlightStaffExclusions).toEqual([
      {
        id: "keep-me",
        enabled: false,
        firstStaffId: second!.id,
        secondStaffId: third!.id,
        flightNo: "",
      },
    ]);
  });

  it("keeps cross-flight priority people synchronized on rename and delete", () => {
    const state = createDefaultState();
    const [first, second] = state.staff;
    state.settings.crossFlightPriorityPolicies = [
      {
        id: "priority-1",
        enabled: true,
        flightNo: "KE166",
        staffIds: [first!.id, second!.id],
      },
    ];

    expect(
      updateConfigurationField(state, "staff", first!.id, "id", "RENAMED")
    ).toBe("updated");
    expect(state.settings.crossFlightPriorityPolicies[0]!.staffIds).toEqual([
      "RENAMED",
      second!.id,
    ]);
    expect(deleteStaff(state, "RENAMED")).toBe(true);
    expect(state.settings.crossFlightPriorityPolicies[0]!.staffIds).toEqual([
      second!.id,
    ]);
  });
});

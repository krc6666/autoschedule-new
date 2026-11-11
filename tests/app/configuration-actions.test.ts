import { configuredFlightPositions } from "../../src/domain/flights/configured-flight-positions";
import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import {
  applyFlightPlanReconciliation,
  addAdministrativeStaff,
  addFlightsFromTemplates,
  cleanupOrphanedFlightRules,
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
import { buildCurrentScheduleFlightCandidates } from "../../src/domain/flights/next-workday-flight-plan";
import { buildFlightPlanReconciliation } from "../../src/domain/flights/flight-plan-reconciliation";
import type { OnlineFlightQueryResult } from "../../src/infrastructure/flight-query";

function normalizeFlightNo(value: string): string {
  return value.trim().replaceAll(/\s+/g, "").toUpperCase();
}

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

  it("syncs template times to matching current flights in both groups and clears their schedules", () => {
    const state = createDefaultState();
    const template = state.templates[0]!;
    const activeFlight = {
      ...state.flights[0]!,
      flightNo: ` ${template.flightNo.toLowerCase()} `,
      bookedPassengers: 87,
      remark: "当天备注",
    };
    const otherGroupFlight = {
      ...state.flights[0]!,
      id: "b-flight",
      flightNo: template.flightNo,
      bookedPassengers: 54,
      remark: "B组备注",
    };
    state.flights = [activeFlight];
    state.groups.A.flights = state.flights;
    state.groups.B.flights = [otherGroupFlight];
    state.activeScheduleDate = "2026-08-17";
    state.groups.A.activeScheduleDate = state.activeScheduleDate;
    state.groups.B.activeScheduleDate = "2026-08-18";
    const makeAssignment = (
      id: string,
      flightId: string,
      flightNo: string
    ) => ({
      id,
      flightId,
      flightNo,
      positionRuleId: null,
      position: "临时岗位",
      staffId: null,
      staffName: "",
      startTime: "08:30",
      endTime: "10:30",
      workHours: 2,
      fatiguePoints: 0,
      remark: "",
      manualRemark: "",
      status: "manual" as const,
    });
    state.assignments = [
      makeAssignment("a-assignment", activeFlight.id, activeFlight.flightNo),
    ];
    state.groups.A.assignments = state.assignments;
    state.groups.B.assignments = [
      makeAssignment(
        "b-assignment",
        otherGroupFlight.id,
        otherGroupFlight.flightNo
      ),
    ];
    const history = {
      id: "history",
      date: "2026-08-01",
      flightNo: template.flightNo,
      position: "H01",
      staffId: "1",
      staffName: "人员",
      startTime: "08:30",
      endTime: "10:30",
      workHours: 2,
      fatiguePoints: 1,
      remark: "归档时段",
    };
    state.history = [history];
    state.groups.A.history = state.history;
    const originalRules = structuredClone(state.positionRules);
    const originalActiveFlight = structuredClone(activeFlight);
    const originalOtherGroupFlight = structuredClone(otherGroupFlight);

    expect(
      updateConfigurationField(
        state,
        "template",
        template.id,
        "startTime",
        "09:00"
      )
    ).toBe("updated");
    expect(
      updateConfigurationField(
        state,
        "template",
        template.id,
        "endTime",
        "11:00"
      )
    ).toBe("updated");

    expect(state.flights[0]).toMatchObject({
      id: originalActiveFlight.id,
      flightNo: originalActiveFlight.flightNo,
      startTime: "09:00",
      endTime: "11:00",
      bookedPassengers: 87,
      remark: "当天备注",
    });
    expect(state.groups.B.flights[0]).toMatchObject({
      id: originalOtherGroupFlight.id,
      startTime: "09:00",
      endTime: "11:00",
      bookedPassengers: 54,
      remark: "B组备注",
    });
    expect(state.assignments).toEqual([]);
    expect(state.groups.B.assignments).toEqual([]);
    expect(state.activeScheduleDate).toBeNull();
    expect(state.groups.B.activeScheduleDate).toBeNull();
    expect(state.positionRules).toEqual(originalRules);
    expect(state.history).toEqual([history]);
    expect(state.templates[0]).toMatchObject({
      startTime: "09:00",
      endTime: "11:00",
    });
    expect(
      buildCurrentScheduleFlightCandidates(state.templates, state.flights).find(
        (candidate) =>
          normalizeFlightNo(candidate.flightNo) ===
          normalizeFlightNo(template.flightNo)
      )
    ).toMatchObject({
      startTime: "09:00",
      endTime: "11:00",
      bookedPassengers: 87,
    });
  });

  it("leaves a group schedule unchanged when that group has no matching current flight", () => {
    const state = createDefaultState();
    const template = state.templates[0]!;
    state.groups.B.activeScheduleDate = "2026-08-18";
    state.groups.B.assignments = [
      {
        id: "b-assignment",
        flightId: "unrelated-flight",
        flightNo: "FD573",
        positionRuleId: null,
        position: "临时岗位",
        staffId: null,
        staffName: "",
        startTime: "15:25",
        endTime: "17:25",
        workHours: 2,
        fatiguePoints: 0,
        remark: "",
        manualRemark: "",
        status: "manual",
      },
    ];

    updateConfigurationField(
      state,
      "template",
      template.id,
      "startTime",
      "09:00"
    );

    expect(state.groups.B.activeScheduleDate).toBe("2026-08-18");
    expect(state.groups.B.assignments).toHaveLength(1);
    expect(state.groups.B.flights).toEqual([]);
  });

  it("updates the active B-group projection when template times change", () => {
    const state = createDefaultState();
    const template = state.templates[0]!;
    const activeFlight = {
      ...state.flights[0]!,
      flightNo: template.flightNo,
      bookedPassengers: 41,
    };
    state.activeGroupId = "B";
    state.flights = [activeFlight];
    state.groups.B.flights = state.flights;
    state.activeScheduleDate = "2026-08-18";
    state.groups.B.activeScheduleDate = state.activeScheduleDate;
    state.assignments = [
      {
        id: "b-assignment",
        flightId: activeFlight.id,
        flightNo: activeFlight.flightNo,
        positionRuleId: null,
        position: "临时岗位",
        staffId: null,
        staffName: "",
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 0,
        remark: "",
        manualRemark: "",
        status: "manual",
      },
    ];
    state.groups.B.assignments = state.assignments;

    updateConfigurationField(
      state,
      "template",
      template.id,
      "startTime",
      "09:00"
    );

    expect(state.flights[0]).toMatchObject({
      startTime: "09:00",
      bookedPassengers: 41,
    });
    expect(state.groups.B.flights[0]).toMatchObject({ startTime: "09:00" });
    expect(state.assignments).toEqual([]);
    expect(state.groups.B.assignments).toEqual([]);
    expect(state.activeScheduleDate).toBeNull();
    expect(state.groups.B.activeScheduleDate).toBeNull();
  });

  it("cleans an orphaned flight's position rules in both groups without deleting flights or history", () => {
    const state = createDefaultState();
    const template = state.templates[0]!;
    const baseRule = state.positionRules[0]!;
    const activeRule = {
      ...baseRule,
      id: "orphan-a",
      flightNo: template.flightNo,
      name: "孤儿A",
    };
    const otherRule = {
      ...baseRule,
      id: "orphan-b",
      flightNo: ` ${template.flightNo.toLowerCase()} `,
      name: "孤儿B",
    };
    state.positionRules = [...state.positionRules, activeRule];
    state.groups.A.positionRules = state.positionRules;
    state.groups.B.positionRules = [...state.groups.B.positionRules, otherRule];
    state.settings.teamLeaderGapFillPositionPolicies = [
      { flightNo: template.flightNo, position: activeRule.name, movable: true },
      { flightNo: "FD573", position: "H01", movable: false },
    ];
    state.settings.latePriorityFlightNumbers = [template.flightNo, "FD573"];
    state.settings.positionTransitionPolicies = [
      {
        id: "orphan-transition",
        name: "orphan",
        enabled: true,
        sourceFlightNo: "FD573",
        sourcePositions: [],
        targetFlightNo: template.flightNo,
        targetPosition: "H01",
        minimumGapMinutes: 90,
        mode: "prefer",
      },
      {
        id: "keep-transition",
        name: "keep",
        enabled: true,
        sourceFlightNo: "FD573",
        sourcePositions: [],
        targetFlightNo: "FD573",
        targetPosition: "H01",
        minimumGapMinutes: 90,
        mode: "prefer",
      },
    ];
    state.groups.A.settings = state.settings;
    state.groups.B.settings.mobileSupervisorFillRules = [
      {
        id: "orphan-fill",
        enabled: true,
        sourceFlightNo: otherRule.flightNo,
        sourcePositionKeyword: otherRule.name,
        targetFlightNo: otherRule.flightNo,
        targetPositionKeyword: otherRule.name,
        allowAutomatic: true,
        allowManual: true,
      },
      {
        id: "keep-fill",
        enabled: true,
        sourceFlightNo: "FD573",
        sourcePositionKeyword: "督导",
        targetFlightNo: "FD573",
        targetPositionKeyword: "H01",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    state.activeScheduleDate = "2026-08-17";
    state.groups.A.activeScheduleDate = state.activeScheduleDate;
    state.groups.B.activeScheduleDate = "2026-08-18";
    state.assignments = [
      {
        id: "assignment-a",
        flightId: state.flights[0]!.id,
        flightNo: template.flightNo,
        positionRuleId: activeRule.id,
        position: activeRule.name,
        staffId: null,
        staffName: "",
        startTime: "08:00",
        endTime: "10:00",
        workHours: 0,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "unfilled",
      },
    ];
    state.groups.A.assignments = state.assignments;
    state.groups.B.assignments = [
      {
        ...state.assignments[0]!,
        id: "assignment-b",
        positionRuleId: otherRule.id,
      },
    ];
    const expectedRemoved =
      state.groups.A.positionRules.filter(
        (rule) =>
          normalizeFlightNo(rule.flightNo) ===
          normalizeFlightNo(template.flightNo)
      ).length +
      state.groups.B.positionRules.filter(
        (rule) =>
          normalizeFlightNo(rule.flightNo) ===
          normalizeFlightNo(template.flightNo)
      ).length;
    deleteTemplate(state, template.id);

    expect(cleanupOrphanedFlightRules(state, template.flightNo)).toBe(
      expectedRemoved
    );
    expect(
      state.groups.A.positionRules.some(
        (rule) =>
          normalizeFlightNo(rule.flightNo) ===
          normalizeFlightNo(template.flightNo)
      )
    ).toBe(false);
    expect(
      state.groups.B.positionRules.some(
        (rule) =>
          normalizeFlightNo(rule.flightNo) ===
          normalizeFlightNo(template.flightNo)
      )
    ).toBe(false);
    expect(
      state.flights.some((flight) => flight.flightNo === template.flightNo)
    ).toBe(true);
    expect(state.history).toEqual([]);
    expect(state.activeScheduleDate).toBeNull();
    expect(state.groups.B.activeScheduleDate).toBeNull();
    expect(state.settings.teamLeaderGapFillPositionPolicies).toEqual([
      { flightNo: "FD573", position: "H01", movable: false },
    ]);
    expect(state.settings.latePriorityFlightNumbers).toEqual(["FD573"]);
    expect(
      state.settings.positionTransitionPolicies.map((rule) => rule.id)
    ).toEqual(["keep-transition"]);
    expect(
      state.groups.B.settings.mobileSupervisorFillRules.map((rule) => rule.id)
    ).toEqual(["keep-fill"]);
  });

  it("does not clean a flight when its template still exists", () => {
    const state = createDefaultState();
    const template = state.templates[0]!;

    expect(cleanupOrphanedFlightRules(state, template.flightNo)).toBe(0);
    expect(
      state.positionRules.some((rule) => rule.flightNo === template.flightNo)
    ).toBe(true);
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

  it("rejects obsolete flight and template position writes without touching either group", () => {
    const state = createDefaultState();
    const before = structuredClone(state);
    for (const [entity, id] of [
      ["template", state.templates[0]!.id],
      ["flight", state.flights[0]!.id],
    ]) {
      expect(
        updateConfigurationField(state, entity!, id!, "positions", "H1,H2")
      ).toBe("missing");
      expect(state).toEqual(before);
    }
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
      positions: configuredFlightPositions(state.positionRules)(
        template.flightNo
      ),
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

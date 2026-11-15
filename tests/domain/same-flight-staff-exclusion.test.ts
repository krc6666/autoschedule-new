import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import type {
  AppState,
  Flight,
  PositionRule,
  ScheduleSettings,
  Staff,
} from "../../src/model";
import { generateSchedule } from "../helpers/generate-schedule";
import { createScheduleLedger } from "../../src/domain/kernel/schedule-ledger";
import {
  createDefaultScheduleGuards,
  ScheduleGuardError,
} from "../../src/domain/kernel/schedule-guard";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import {
  matchingSameFlightStaffExclusion,
  sameFlightStaffExclusionPairMessage,
  sameFlightStaffExclusionViolations,
} from "../../src/domain/rules/same-flight-staff-exclusion";

interface ExclusionInput {
  id: string;
  enabled: boolean;
  staffIds: string[];
  flightNo: string;
}

type SettingsWithExclusions = ScheduleSettings & {
  sameFlightStaffExclusions: ExclusionInput[];
};

const DATE = "2026-09-15";

function staff(id: string, name: string): Staff {
  return {
    id,
    name,
    staffType: "常规",
    teamLeader: false,
    cxPreflightQualified: false,
    dutyQualified: false,
    standbyQualified: false,
    nightShift: true,
    status: "正常",
    remark: "",
  };
}

function flight(flightNo: string): Flight {
  return {
    id: `flight-${flightNo.toLowerCase()}`,
    flightNo,
    startTime: "08:00",
    endTime: "10:00",
    bookedPassengers: 100,
    positions: ["G01", "G02"],
    remark: "",
  };
}

function positionRule(
  flightNo: string,
  name: string,
  qualifiedStaffIds: string[]
): PositionRule {
  return {
    id: `rule-${flightNo.toLowerCase()}-${name.toLowerCase()}`,
    flightNo,
    name,
    category: "常规",
    remark: "",
    qualifiedStaffIds,
    manual: false,
    fatiguePoints: 1,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
  };
}

function scenario(
  options: {
    flightNo?: string;
    enabled?: boolean;
    pair?: readonly [string, string];
    scopedFlightNo?: string;
    staffIds?: readonly string[];
  } = {}
): AppState {
  const state = createDefaultState();
  const flightNo = options.flightNo ?? "F100";
  const staffIds = options.staffIds ?? ["worker-a", "worker-b"];
  const people = staffIds.map((id) => staff(id, id.toUpperCase()));
  const targetFlight = flight(flightNo);
  state.staff = people;
  state.flights = [targetFlight];
  state.templates = [];
  state.positionRules = [
    positionRule(flightNo, "G01", [staffIds[0]!]),
    positionRule(flightNo, "G02", [staffIds[1]!]),
  ];
  state.history = [];
  state.assignments = [];
  state.dutyRosterOverrides = [
    {
      date: DATE,
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  state.settings.workloadBalanceEnabled = false;
  state.settings.positionRotationEnabled = false;
  state.settings.lateShiftRecoveryEnabled = false;
  const pair = options.pair ?? [staffIds[0]!, staffIds[1]!];
  (state.settings as SettingsWithExclusions).sameFlightStaffExclusions = [
    {
      id: "exclusion-1",
      enabled: options.enabled ?? true,
      staffIds: [pair[0], pair[1]],
      flightNo: options.scopedFlightNo ?? "",
    },
  ];
  return state;
}

function assignedStaffIds(state: AppState) {
  return generateSchedule(state, DATE).then((result) =>
    result.assignments
      .filter((assignment) => assignment.status === "assigned")
      .map((assignment) => assignment.staffId)
  );
}

describe("same-flight staff exclusion", () => {
  it("reports the actual conflicting members in configured order", () => {
    const state = scenario({ staffIds: ["worker-a", "worker-b", "worker-c"] });
    const group = {
      id: "group",
      enabled: true,
      flightNo: "",
      staffIds: ["worker-a", "worker-b", "worker-c"],
    };
    expect(
      sameFlightStaffExclusionPairMessage(
        state,
        group,
        "F100",
        "worker-c",
        "worker-b"
      )
    ).toBe("WORKER-B与WORKER-C不能同时安排在F100");
  });

  it("excludes the second and third members of a multi-person group", async () => {
    const state = scenario({ staffIds: ["worker-a", "worker-b", "worker-c"] });
    state.positionRules[0]!.qualifiedStaffIds = ["worker-b"];
    state.positionRules[1]!.qualifiedStaffIds = ["worker-c"];
    state.settings.sameFlightStaffExclusions = [
      {
        id: "group",
        enabled: true,
        flightNo: "",
        staffIds: ["worker-a", "worker-b", "worker-c"],
      },
    ];
    expect(
      matchingSameFlightStaffExclusion(state, "worker-b", "worker-c", "F100")
        ?.id
    ).toBe("group");
    expect(await assignedStaffIds(state)).toHaveLength(1);
  });

  it("never assigns an excluded pair to the same flight", async () => {
    const assigned = await assignedStaffIds(scenario());

    expect(assigned).toHaveLength(1);
    expect(new Set(assigned)).toEqual(
      new Set([expect.stringMatching(/^worker-[ab]$/)])
    );
  });

  it("ignores a disabled exclusion during initial scheduling", async () => {
    const assigned = await assignedStaffIds(scenario({ enabled: false }));

    expect(assigned).toHaveLength(2);
  });

  it("ignores disabled rows during candidate conflict checks", () => {
    const state = scenario({ enabled: false });

    expect(
      matchingSameFlightStaffExclusion(state, "worker-a", "worker-b", "F100")
    ).toBeUndefined();

    state.settings.sameFlightStaffExclusions[0]!.enabled = true;
    expect(
      matchingSameFlightStaffExclusion(state, "worker-a", "worker-b", "F100")
    ).toMatchObject({ id: "exclusion-1", enabled: true });
  });

  it("applies to another configured pair without relying on names", async () => {
    const assigned = await assignedStaffIds(
      scenario({
        pair: ["worker-b", "worker-c"],
        staffIds: ["worker-b", "worker-c"],
      })
    );

    expect(assigned).toHaveLength(1);
  });

  it("treats an empty flight number as all flights", async () => {
    const assigned = await assignedStaffIds(
      scenario({ flightNo: "F200", scopedFlightNo: "" })
    );

    expect(assigned).toHaveLength(1);
  });

  it("limits a scoped rule to its configured flight", async () => {
    const assigned = await assignedStaffIds(
      scenario({ flightNo: "F200", scopedFlightNo: "F100" })
    );

    expect(assigned).toHaveLength(2);
  });

  it("allows one excluded person to兼任 multiple positions on the same flight", () => {
    const state = scenario();
    const [firstRule, secondRule] = state.positionRules;
    const assignments = [firstRule, secondRule].map((rule, index) => ({
      id: `same-staff-${index}`,
      flightId: state.flights[0]!.id,
      flightNo: "F100",
      positionRuleId: rule!.id,
      position: rule!.name,
      staffId: "worker-a",
      staffName: "WORKER-A",
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned" as const,
    }));

    expect(sameFlightStaffExclusionViolations(state, assignments)).toEqual([]);
  });

  it.each([false, true])(
    "rejects a post-stage proposal that reintroduces excluded people (multi=%s)",
    (multi) => {
      const state = scenario();
      if (multi) {
        state.staff.push(staff("third-person", "THIRD"));
        state.settings.sameFlightStaffExclusions[0]!.staffIds = [
          "third-person",
          "worker-a",
          "worker-b",
        ];
      }
      const [firstRule, secondRule] = state.positionRules;
      const legal = {
        id: "assignment-a",
        flightId: state.flights[0]!.id,
        flightNo: "F100",
        positionRuleId: firstRule!.id,
        position: firstRule!.name,
        staffId: "worker-a",
        staffName: "WORKER-A",
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned" as const,
      };
      const illegal = {
        ...legal,
        id: "assignment-b",
        positionRuleId: secondRule!.id,
        position: secondRule!.name,
        staffId: "worker-b",
        staffName: "WORKER-B",
      };
      const ledger = createScheduleLedger([legal], {
        safetySession: createScheduleSafetySession({
          phase: "partial",
          state,
          date: "2026-09-28",
          runFacts: createScheduleRunFacts(state, "2026-09-28"),
          guards: createDefaultScheduleGuards(),
        }),
      });

      let error: unknown;
      try {
        ledger.commit({ type: "replace", assignments: [legal, illegal] });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ScheduleGuardError);
      expect((error as ScheduleGuardError).violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: "same-flight-staff-exclusion" }),
        ])
      );
      expect(ledger.snapshot()).toEqual([legal]);
    }
  );

  it("ignores a disabled exclusion in the final post-stage guard", () => {
    const state = scenario({ enabled: false });
    const [firstRule, secondRule] = state.positionRules;
    const first = {
      id: "assignment-a",
      flightId: state.flights[0]!.id,
      flightNo: "F100",
      positionRuleId: firstRule!.id,
      position: firstRule!.name,
      staffId: "worker-a",
      staffName: "WORKER-A",
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned" as const,
    };
    const second = {
      ...first,
      id: "assignment-b",
      positionRuleId: secondRule!.id,
      position: secondRule!.name,
      staffId: "worker-b",
      staffName: "WORKER-B",
    };
    const ledger = createScheduleLedger([first], {
      safetySession: createScheduleSafetySession({
        phase: "partial",
        state,
        date: "2026-09-28",
        runFacts: createScheduleRunFacts(state, "2026-09-28"),
        guards: createDefaultScheduleGuards(),
      }),
    });

    expect(() =>
      ledger.commit({ type: "replace", assignments: [first, second] })
    ).not.toThrow();
    expect(ledger.snapshot()).toEqual([first, second]);
  });
});

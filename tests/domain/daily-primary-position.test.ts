import { describe, expect, it } from "vitest";
import type { Assignment, Flight, PositionRule, Staff } from "../../src/model";
import {
  createDefaultScheduleSettings,
  normalizeScheduleSettings,
} from "../../src/domain/rules/schedule-settings";
import { isDailyPrimaryPosition } from "../../src/domain/rules/daily-primary-position";
import { diagnoseDailyPrimaryPositionEligibility } from "../../src/domain/candidates/assignment-eligibility";
import { createDailyPrimaryPositionScheduleGuard } from "../../src/domain/kernel/schedule-guard";

const flights: Flight[] = [
  {
    id: "f1",
    flightNo: "CA101",
    startTime: "08:00",
    endTime: "10:00",
    bookedPassengers: 100,
    positions: [],
    remark: "",
  },
  {
    id: "f2",
    flightNo: "MU202",
    startTime: "12:00",
    endTime: "14:00",
    bookedPassengers: 100,
    positions: [],
    remark: "",
  },
];
const supervisor: PositionRule = {
  id: "s1",
  flightNo: "CA101",
  name: "督导",
  category: "机动督导",
  remark: "",
  qualifiedStaffIds: ["p1"],
  manual: false,
  fatiguePoints: 1,
  minPassengers: 0,
  earlyReleaseMinutes: 0,
};
const firstOne: PositionRule = {
  id: "p1a",
  flightNo: "CA101",
  name: "柜台A",
  category: "常规",
  remark: "",
  qualifiedStaffIds: ["p1"],
  manual: false,
  fatiguePoints: 1,
  minPassengers: 0,
  earlyReleaseMinutes: 0,
};
const secondOne: PositionRule = {
  id: "p2a",
  flightNo: "MU202",
  name: "柜台B",
  category: "常规",
  remark: "",
  qualifiedStaffIds: ["p1"],
  manual: false,
  fatiguePoints: 1,
  minPassengers: 0,
  earlyReleaseMinutes: 0,
};
const person: Staff = {
  id: "p1",
  name: "张三",
  staffType: "常规",
  teamLeader: false,
  cxPreflightQualified: false,
  dutyQualified: false,
  standbyQualified: false,
  nightShift: true,
  status: "正常",
  remark: "",
};

const state = () => ({
  flights,
  assignments: [],
  positionRules: [supervisor, firstOne, secondOne],
  settings: {
    ...createDefaultScheduleSettings(),
    dailyPrimaryPositionUniqueEnabled: true,
  },
  staff: [person],
});

const assigned = (
  id: string,
  flight: Flight,
  rule: PositionRule
): Assignment => ({
  id,
  flightId: flight.id,
  flightNo: flight.flightNo,
  positionRuleId: rule.id,
  position: rule.name,
  staffId: person.id,
  staffName: person.name,
  startTime: flight.startTime,
  endTime: flight.endTime,
  workHours: 2,
  fatiguePoints: 1,
  remark: "",
  manualRemark: "",
  status: "assigned",
});

describe("daily primary position uniqueness", () => {
  it("defaults on and restores as on when an old config omits the field", () => {
    expect(
      createDefaultScheduleSettings().dailyPrimaryPositionUniqueEnabled
    ).toBe(true);
    expect(
      normalizeScheduleSettings({}).dailyPrimaryPositionUniqueEnabled
    ).toBe(true);
  });

  it("defines the first non-supervisor position independently of its name", () => {
    expect(isDailyPrimaryPosition(state(), flights[0]!, firstOne)).toBe(true);
    expect(isDailyPrimaryPosition(state(), flights[0]!, supervisor)).toBe(
      false
    );
  });

  it("rejects a second primary position for the same person", () => {
    const diagnostic = diagnoseDailyPrimaryPositionEligibility({
      state: state(),
      assignments: [assigned("a1", flights[0]!, firstOne)],
      flight: flights[1]!,
      rule: secondOne,
      person,
    });
    expect(diagnostic.eligible).toBe(false);
    expect(diagnostic.violations[0]?.code).toBe(
      "daily-primary-position-unique"
    );
  });

  it("rejects a duplicate in the final snapshot and ignores supervisors", () => {
    const guard = createDailyPrimaryPositionScheduleGuard();
    const context = { dailyPrimaryPositionFacts: { state: state() } } as never;
    expect(
      guard.validate(
        [
          assigned("a1", flights[0]!, firstOne),
          assigned("a2", flights[1]!, secondOne),
        ],
        context
      )
    ).toHaveLength(1);
    expect(
      guard.validate(
        [
          assigned("a1", flights[0]!, supervisor),
          assigned("a2", flights[1]!, secondOne),
        ],
        context
      )
    ).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import type { Assignment, Flight, PositionRule, Staff } from "../../src/model";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { fillVacancyWithTeamLeaderConcurrentSupervision } from "../../src/domain/coverage/team-leader-concurrent-supervision";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import {
  createTeamLeaderConcurrentCycleScenario,
  createTeamLeaderConcurrentDutyScenario,
  createTeamLeaderConcurrentLongChainScenario,
} from "../helpers/scheduling-scenario";

function staff(id: string, teamLeader = false): Staff {
  return {
    id,
    name: `员工${id}`,
    staffType: "常规",
    teamLeader,
    cxPreflightQualified: false,
    dutyQualified: false,
    standbyQualified: true,
    nightShift: true,
    status: "正常",
    remark: "",
  };
}

function flight(
  id: string,
  flightNo: string,
  startTime: string,
  endTime: string
): Flight {
  return {
    id,
    flightNo,
    startTime,
    endTime,
    bookedPassengers: 100,
    positions: [],
    remark: "",
  };
}

function rule(
  id: string,
  flightNo: string,
  name: string,
  qualifiedStaffIds: string[],
  category: PositionRule["category"] = "常规"
): PositionRule {
  return {
    id,
    flightNo,
    name,
    category,
    remark: "",
    qualifiedStaffIds,
    manual: false,
    fatiguePoints: 1,
    minPassengers: 0,
    earlyReleaseMinutes: category === "分流" ? 15 : 0,
  };
}

function assignment(
  rule: PositionRule,
  flight: Flight,
  person: Staff | null,
  endTime = flight.endTime
): Assignment {
  return {
    id: `assignment-${rule.id}`,
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: rule.id,
    position: rule.name,
    staffId: person?.id ?? null,
    staffName: person?.name ?? "",
    startTime: flight.startTime,
    endTime,
    workHours: person ? 2 : 0,
    fatiguePoints: rule.fatiguePoints,
    remark: "",
    manualRemark: "",
    status: person ? "assigned" : "unfilled",
  };
}

describe("team leader concurrent supervision", () => {
  it("can use an idle duty worker for a new ordinary vacancy without moving locked duty positions", async () => {
    const { state, dutyWorker, morningDuty, lateDuty, lockedAssignmentIds } =
      createTeamLeaderConcurrentDutyScenario();
    // The purpose here is assignment-level duty locking, not repeated first jobs.
    state.settings.dailyPrimaryPositionUniqueEnabled = false;

    await fillVacancyWithTeamLeaderConcurrentSupervision(
      defaultHighsSolver,
      state,
      state.assignments,
      "2026-07-29",
      lockedAssignmentIds,
      createScheduleRunFacts(state, "2026-07-29")
    );

    expect(
      state.assignments.find((item) => item.positionRuleId === "second-vacancy")
    ).toMatchObject({
      staffId: dutyWorker.id,
      status: "assigned",
    });
    expect(morningDuty.staffId).toBe(dutyWorker.id);
    expect(lateDuty.staffId).toBe(dutyWorker.id);
  });

  it("terminates a cyclic vacancy-transfer search instead of overflowing the call stack", async () => {
    const { state } = createTeamLeaderConcurrentCycleScenario();

    await fillVacancyWithTeamLeaderConcurrentSupervision(
      defaultHighsSolver,
      state,
      state.assignments,
      "2026-07-29",
      new Set(),
      createScheduleRunFacts(state, "2026-07-29")
    );
    expect(
      state.assignments.filter((item) => item.status === "unfilled")
    ).toHaveLength(1);
  });

  it("keeps the vacancy when a qualified chain exceeds three participants", async () => {
    const { state, leader, releasedSupervisor, workers } =
      createTeamLeaderConcurrentLongChainScenario();

    const messages = await fillVacancyWithTeamLeaderConcurrentSupervision(
      defaultHighsSolver,
      state,
      state.assignments,
      "2026-07-29",
      new Set(),
      createScheduleRunFacts(state, "2026-07-29")
    );

    expect(messages).toEqual([]);
    expect(
      state.assignments.find((item) => item.positionRuleId === "vacancy")
    ).toMatchObject({ staffId: null, status: "unfilled" });
    expect(
      state.assignments.find((item) => item.positionRuleId === "relay-4")
    ).toMatchObject({ staffId: workers[3]!.id, status: "assigned" });
    expect(
      state.assignments.filter((item) =>
        ["first-supervisor", "second-supervisor"].includes(
          item.positionRuleId ?? ""
        )
      )
    ).toEqual([
      expect.objectContaining({ staffId: releasedSupervisor.id }),
      expect.objectContaining({ staffId: leader.id }),
    ]);
  });

  it("never uses short-overlap concurrent supervision when either flight is KE166", async () => {
    const state = createDefaultState();
    const leader = staff("leader", true);
    const keSupervisor = staff("ke-supervisor");
    state.staff = [leader, keSupervisor];
    state.flights = [
      flight("ke", "KE166", "09:15", "11:15"),
      flight("other", "OTHER1", "11:00", "13:00"),
    ];
    const [ke, other] = state.flights;
    state.positionRules = [
      rule("ke-supervisor-role", "KE166", "督导", [leader.id, keSupervisor.id]),
      rule("other-supervisor-role", "OTHER1", "督导", [
        leader.id,
        keSupervisor.id,
      ]),
      rule("other-vacancy", "OTHER1", "G10", [keSupervisor.id]),
    ];
    const byId = new Map(state.positionRules.map((item) => [item.id, item]));
    state.assignments = [
      assignment(byId.get("ke-supervisor-role")!, ke!, keSupervisor),
      assignment(byId.get("other-supervisor-role")!, other!, leader),
      assignment(byId.get("other-vacancy")!, other!, null),
    ];

    const messages = await fillVacancyWithTeamLeaderConcurrentSupervision(
      defaultHighsSolver,
      state,
      state.assignments,
      "2026-07-29",
      new Set(),
      createScheduleRunFacts(state, "2026-07-29")
    );

    expect(messages).toEqual([]);
    expect(
      state.assignments.find((item) => item.positionRuleId === "other-vacancy")
    ).toMatchObject({
      staffId: null,
      status: "unfilled",
    });
    expect(
      state.assignments.find(
        (item) => item.positionRuleId === "ke-supervisor-role"
      )?.staffId
    ).toBe(keSupervisor.id);
  });
});

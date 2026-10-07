import { describe, expect, it } from "vitest";

import { groupStaffFlightsByNormalizedNumber } from "../../src/domain/statistics/staff-flight-count";
import { createDefaultState } from "../../src/defaults";
import { enforceDailyFlightCountBalance } from "../../src/domain/assignments/daily-flight-count-balance";
import type { Assignment, Flight, PositionRule } from "../../src/model";

describe("staff flight count facts", () => {
  it("groups positions by staff and normalized flight number", () => {
    const groups = groupStaffFlightsByNormalizedNumber([
      { staffId: "a", flightNo: " cx931 ", position: "G18" },
      { staffId: "a", flightNo: "CX931", position: "G20" },
      { staffId: "a", flightNo: "AK151", position: "G01" },
      { staffId: "b", flightNo: "CX931", position: "G18" },
      { staffId: "a", flightNo: "轮 值", position: "值班" },
    ]);

    expect([...(groups.get("a")?.keys() ?? [])]).toEqual(["CX931", "AK151"]);
    expect(groups.get("a")?.get("CX931")).toHaveLength(2);
    expect(groups.get("b")?.get("CX931")).toHaveLength(1);
  });

  it("counts KE166 supervisor, guide reuse, and zero-hour fill as one flight", () => {
    const groups = groupStaffFlightsByNormalizedNumber([
      {
        staffId: "ke166-supervisor",
        flightNo: "KE166",
        position: "督导",
        workHours: 2,
      },
      {
        staffId: "ke166-supervisor",
        flightNo: "KE166",
        position: "H05",
        supervisorSourceAssignmentId: "supervisor-assignment",
        workHours: 0,
      },
      {
        staffId: "ke166-supervisor",
        flightNo: "KE166",
        position: "柜台引导",
        workHours: 0,
      },
    ]);

    expect(groups.get("ke166-supervisor")?.size).toBe(1);
    expect(groups.get("ke166-supervisor")?.get("KE166")).toHaveLength(3);
  });

  it("rebalances a post-processing 4-to-2 spread by transferring a whole flight group", () => {
    const state = createDefaultState();
    state.settings.dailyPrimaryPositionUniqueEnabled = false;
    const [high, low] = state.staff.filter(
      (person) => person.staffType === "常规"
    );
    high!.teamLeader = false;
    low!.teamLeader = false;
    high!.dutyQualified = false;
    low!.dutyQualified = false;
    const flights: Flight[] = Array.from({ length: 6 }, (_, index) => ({
      id: `flight-${index}`,
      flightNo: `AA${100 + index}`,
      startTime: `${String(6 + index * 3).padStart(2, "0")}:00`,
      endTime: `${String(7 + index * 3).padStart(2, "0")}:00`,
      bookedPassengers: 100,
      positions: ["G01"],
      remark: "",
    }));
    const baseRule = state.positionRules[0]!;
    const positionRules: PositionRule[] = flights.map((flight) => ({
      ...baseRule,
      id: `${flight.id}-rule`,
      flightNo: flight.flightNo,
      name: "G01",
      category: "常规",
      qualifiedStaffIds: [high!.id, low!.id],
      manual: false,
    }));
    const assignmentFor = (
      flight: Flight,
      rule: PositionRule,
      person: typeof high
    ): Assignment => ({
      id: `${flight.id}-${person!.id}`,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: person!.id,
      staffName: person!.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 1,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    });
    const assignments = [
      ...flights
        .slice(0, 4)
        .map((flight, index) =>
          assignmentFor(flight, positionRules[index]!, high)
        ),
      ...flights
        .slice(4)
        .map((flight, index) =>
          assignmentFor(flight, positionRules[index + 4]!, low)
        ),
    ];
    state.flights = flights;
    state.positionRules = positionRules;
    state.assignments = assignments;

    const result = enforceDailyFlightCountBalance(state, assignments, {
      dutyStaffId: null,
      candidateStaffIds: new Set([high!.id, low!.id]),
      useFullEligibility: true,
    });
    const grouped = groupStaffFlightsByNormalizedNumber(
      assignments.flatMap((assignment) =>
        assignment.staffId
          ? [{ staffId: assignment.staffId, flightNo: assignment.flightNo }]
          : []
      )
    );

    expect(result.changed).toBe(true);
    expect(result.spread).toBeLessThanOrEqual(1);
    expect(grouped.get(high!.id)?.size).toBe(3);
    expect(grouped.get(low!.id)?.size).toBe(3);
  });
});

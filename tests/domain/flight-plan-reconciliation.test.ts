import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import type { OnlineFlightQueryResult } from "../../src/infrastructure/flight-query";
import { buildFlightPlanReconciliation } from "../../src/domain/flights/flight-plan-reconciliation";

function queryResult(
  date: string,
  flightNos: string[]
): OnlineFlightQueryResult {
  return {
    date,
    nextDate: "2026-07-28",
    fetchedAt: "2026-07-26T05:49:13.434Z",
    sourceUrls: [],
    flights: flightNos.map((flightNo, index) => ({
      key: `${date}|${index}|${flightNo}`,
      date,
      flightNo,
      departureTime: `${10 + index}:00`,
      destination: `D${index}`,
      destinationCity: `Destination ${index}`,
      country: "韩国",
      countryCode: "KR",
    })),
  };
}

describe("flight plan reconciliation", () => {
  it("does not suggest a spare template as a current-season addition", () => {
    const state = createDefaultState();
    state.templates.push({
      ...state.templates[0]!,
      id: "spare",
      flightNo: "SPARE100",
    });
    const result = buildFlightPlanReconciliation(
      state,
      "2026-11-11",
      queryResult("2026-11-11", ["SPARE100"])
    );
    expect(result.additions).toEqual([]);
    expect(result.unmatched.map((f) => f.flightNo)).toEqual(["SPARE100"]);
  });
  it("classifies retained, addable, unmatched, and removal-candidate flights", () => {
    const state = createDefaultState();
    const [retainedTemplate, addableTemplate] = state.templates;
    state.flights = [
      {
        ...structuredClone(retainedTemplate!),
        id: "retained",
        bookedPassengers: 88,
      },
      {
        ...structuredClone(state.templates[2]!),
        id: "removal",
        bookedPassengers: 66,
      },
    ];
    const result = queryResult("2026-07-27", [
      retainedTemplate!.flightNo,
      addableTemplate!.flightNo,
      "NO-TEMPLATE",
    ]);

    const reconciliation = buildFlightPlanReconciliation(
      state,
      "2026-07-27",
      result
    );

    expect(reconciliation.retained.map((item) => item.flight.id)).toEqual([
      "retained",
    ]);
    expect(reconciliation.additions.map((item) => item.template.id)).toEqual([
      addableTemplate!.id,
    ]);
    expect(reconciliation.unmatched.map((item) => item.flightNo)).toEqual([
      "NO-TEMPLATE",
    ]);
    expect(reconciliation.removals.map((item) => item.id)).toEqual(["removal"]);
    expect(reconciliation.removalAllowed).toBe(true);
  });

  it("prohibits removals for an empty result or a date different from the current schedule", () => {
    const state = createDefaultState();
    const differentDate = buildFlightPlanReconciliation(
      state,
      "2026-07-27",
      queryResult("2026-07-28", [state.flights[0]!.flightNo])
    );
    const emptyResult = buildFlightPlanReconciliation(
      state,
      "2026-07-27",
      queryResult("2026-07-27", [])
    );

    expect(differentDate.removalAllowed).toBe(false);
    expect(differentDate.removalBlockedReason).toContain(
      "查询日期与当前排班日期不一致"
    );
    expect(emptyResult.removalAllowed).toBe(false);
    expect(emptyResult.removalBlockedReason).toContain("查询结果为空");
  });
});

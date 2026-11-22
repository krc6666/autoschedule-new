import { expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import {
  flightLeaderScenario,
  LEADER_DATE,
} from "../helpers/flight-leader-scenario";
import { improveFlightLeaderCoverage } from "../../src/domain/reviews/flight-leader-coverage";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";

it("keeps large-history leader improvement bounded and preserves all existing jobs and personal loads", async () => {
  const state = flightLeaderScenario(8);
  state.history = Array.from({ length: 900 }, (_, i) => ({
    id: `history-${i}`,
    date: "2026-11-20",
    flightNo: "ZZ100",
    position: "柜台1",
    staffId: state.staff[i % state.staff.length]!.id,
    staffName: `历史人员${i % state.staff.length}`,
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 1,
    remark: "",
  }));
  const started = performance.now();
  const result = await improveFlightLeaderCoverage({
    state,
    date: LEADER_DATE,
    assignments: state.assignments,
    facts: createScheduleRunFacts(state, LEADER_DATE),
    solver: defaultHighsSolver,
    lockedAssignmentIds: new Set(),
    assertSafe: () => undefined,
  });
  const elapsedMs = performance.now() - started;
  const leaders = new Set(
    state.staff.filter((p) => p.flightLeaderQualified).map((p) => p.id)
  );
  const counts = state.flights.map(
    (f) =>
      new Set(
        result
          .filter((a) => a.flightId === f.id && leaders.has(a.staffId!))
          .map((a) => a.staffId)
      ).size
  );
  expect(elapsedMs).toBeLessThan(12_000);
  expect(counts.filter((n) => n === 0).length).toBeLessThan(4);
  expect(counts.slice(0, 4).every((n) => n >= 1)).toBe(true);
  expect(result.map((a) => a.id)).toEqual(state.assignments.map((a) => a.id));
  expect(result.every((a) => a.status === "assigned")).toBe(true);
  for (const p of state.staff) {
    const own = result.filter((a) => a.staffId === p.id);
    expect(own).toHaveLength(1);
    expect(own[0]!.workHours).toBe(2);
    expect(own[0]!.fatiguePoints).toBe(1);
  }
  writeFileSync(
    "docs/acceptance/evidence/2026-11-22-flight-leader-performance.json",
    JSON.stringify(
      {
        historyRows: 900,
        flights: 8,
        people: 16,
        counts,
        elapsedMs,
        jobs: result.length,
        meaning: "本机一次性能门禁，不代表生产耗时或提速承诺",
      },
      null,
      2
    ) + "\n"
  );
}, 15_000);

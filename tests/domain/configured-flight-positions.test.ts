import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  configuredFlightPositions,
  configuredSeasonTemplates,
  withConfiguredFlightPositions,
} from "../../src/domain/flights/configured-flight-positions";
import { generateSchedule } from "../helpers/generate-schedule";

describe("configured flight position ownership", () => {
  it("includes every configured season flight while keeping spare templates out and never guessing a missing time", () => {
    const state = createDefaultState();
    const rule = state.positionRules[0]!;
    const rules = [
      { ...rule, flightNo: "ACTIVE100" },
      { ...rule, flightNo: "NO-TIME" },
    ];
    const templates = [{ ...state.templates[0]!, flightNo: "SPARE100" }];
    const current = [
      {
        ...state.flights[0]!,
        flightNo: "ACTIVE100",
        startTime: "10:00",
        endTime: "12:00",
      },
    ];
    const before = structuredClone({ rules, templates, current });
    expect(configuredSeasonTemplates(templates, rules, current)).toMatchObject([
      { flightNo: "ACTIVE100", startTime: "10:00", endTime: "12:00" },
      { flightNo: "NO-TIME", startTime: "", endTime: "" },
    ]);
    expect({ rules, templates, current }).toEqual(before);
  });
  it("matches normalized flight numbers, keeps seasonal suffixes distinct and returns independent read-only projections", () => {
    const base = createDefaultState().positionRules[0]!;
    const rules = [
      { ...base, flightNo: "tr 121", name: " 督导/引导 " },
      { ...base, flightNo: "TR121", name: "H02" },
      {
        ...base,
        flightNo: "TR121",
        name: "H02",
        category: "行政支援" as const,
      },
      { ...base, flightNo: "TR121(晚)", name: "H03" },
    ];
    const before = structuredClone(rules);
    const list = configuredFlightPositions(rules);
    expect(list("TR121")).toEqual(["督导/引导", "H02"]);
    expect(list("TR121(晚)")).toEqual(["H03"]);
    expect(list("TR121(早)")).toEqual([]);
    list("TR121").push("untrusted");
    expect(list("TR121")).toEqual(["督导/引导", "H02"]);
    expect(
      withConfiguredFlightPositions(
        [{ flightNo: "UNKNOWN", positions: ["STALE"] }],
        rules
      )[0]!.positions
    ).toEqual([]);
    expect(rules).toEqual(before);
  });

  it("keeps final generated assignments owned by group rules despite missing or stale flight snapshots and after deleting a job", async () => {
    const state = createDefaultState();
    state.history = [];
    state.staff.forEach((person) => {
      person.teamLeader = false;
    });
    state.flights = [
      {
        ...state.flights[0]!,
        flightNo: "TEST100",
        startTime: "10:00",
        endTime: "12:00",
        positions: ["STALE"],
        bookedPassengers: 200,
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = ["H02", "H03"].map((name) => ({
      ...base,
      id: name,
      flightNo: "TEST100",
      name,
      category: "常规",
      manual: false,
      minPassengers: 0,
      qualifiedStaffIds: state.staff
        .filter((p) => p.staffType === "常规" && p.status === "正常")
        .map((p) => p.id),
    }));
    const first = await generateSchedule(state, "2026-11-19");
    expect(first.assignments.map((a) => a.position)).toEqual(["H02", "H03"]);
    expect(
      first.assignments.every((a) => a.staffId && a.status === "assigned")
    ).toBe(true);
    state.positionRules = state.positionRules.filter((r) => r.name !== "H02");
    state.flights[0]!.positions = ["H02", "H03", "STALE"];
    const second = await generateSchedule(state, "2026-11-19");
    expect(second.assignments.map((a) => a.position)).toEqual(["H03"]);
    expect(second.assignments[0]!.status).toBe("assigned");
  });
});

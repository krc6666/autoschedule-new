import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import type {
  AppState,
  Assignment,
  HistoryRecord,
  Staff,
} from "../../src/model";
import { reviewSamePositionFrequency } from "../../src/domain/reviews/position-frequency-review";
import { assessPositionFrequencyAlert } from "../../src/domain/reviews/position-frequency-alert";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { createScheduleFrequencyFacts } from "../../src/domain/statistics/schedule-frequency";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";

const DATE = "2026-08-18";

function frequencyState(): {
  state: AppState;
  first: Staff;
  second: Staff;
} {
  const state = createDefaultState();
  const [first, second] = state.staff
    .filter((person) => person.status === "正常")
    .slice(0, 2);
  state.staff = [first!, second!];
  state.staff.forEach((person) => {
    person.dutyQualified = false;
    person.nightShift = true;
  });
  state.flights = [
    {
      id: "flight",
      flightNo: "TEST100",
      startTime: "08:00",
      endTime: "10:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
  ];
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "priority",
      flightNo: "TEST100",
      name: "G20",
      remark: "一号",
      category: "常规",
      qualifiedStaffIds: [first!.id, second!.id],
    },
  ];
  state.settings.ordinaryPriorityPositions = [
    { airlineCode: "TEST100", position: "G20" },
  ];
  state.history = [];
  return { state, first: first!, second: second! };
}

function assignment(person: Staff): Assignment {
  return {
    id: "assignment",
    flightId: "flight",
    flightNo: "TEST100",
    positionRuleId: "priority",
    position: "G20",
    staffId: person.id,
    staffName: person.name,
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 5,
    remark: "一号",
    manualRemark: "",
    status: "assigned",
  };
}

function record(person: Staff, date: string, index: number): HistoryRecord {
  return {
    id: `${person.id}-${index}`,
    date,
    flightNo: "TEST100",
    position: "G20",
    staffId: person.id,
    staffName: person.name,
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 5,
    remark: "一号",
  };
}

describe("priority-position frequency warning", () => {
  it("finishes the first qualified-worker round before assigning a second turn", async () => {
    const { state, first, second } = frequencyState();
    state.history = [record(first, "2026-08-16", 0)];
    const assignments = [assignment(first)];

    const warnings = await reviewSamePositionFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(assignments[0]?.staffId).toBe(second.id);
  });

  it("uses a cross-flight swap to give a late supervisor role to a zero-frequency worker", async () => {
    const { state, first: frequent, second: underused } = frequencyState();
    state.flights = [
      {
        id: "target-flight",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "overlap-flight",
        flightNo: "TWB616",
        startTime: "22:10",
        endTime: "00:10",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...state.positionRules[0]!,
        id: "tr-supervisor",
        flightNo: "TR121",
        name: "督导",
        remark: "",
        qualifiedStaffIds: [frequent.id, underused.id],
      },
      {
        ...state.positionRules[0]!,
        id: "tw-ordinary",
        flightNo: "TWB616",
        name: "G13",
        remark: "",
        qualifiedStaffIds: [frequent.id, underused.id],
      },
    ];
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "TR", position: "督导" },
    ];
    state.history = [
      {
        ...record(frequent, "2026-08-12", 0),
        flightNo: "TR121",
        position: "督导",
        remark: "",
      },
      {
        ...record(frequent, "2026-08-14", 1),
        flightNo: "TR121",
        position: "督导",
        remark: "",
      },
      {
        ...record(underused, "2026-08-16", 2),
        flightNo: "OTHER",
        position: "H04",
        remark: "申报",
        startTime: "21:55",
        endTime: "23:55",
      },
    ];
    const assignments: Assignment[] = [
      {
        ...assignment(frequent),
        id: "tr-supervisor-assignment",
        flightId: "target-flight",
        flightNo: "TR121",
        positionRuleId: "tr-supervisor",
        position: "督导",
        remark: "",
        startTime: "21:55",
        endTime: "23:55",
      },
      {
        ...assignment(underused),
        id: "tw-ordinary-assignment",
        flightId: "overlap-flight",
        flightNo: "TWB616",
        positionRuleId: "tw-ordinary",
        position: "G13",
        remark: "",
        startTime: "22:10",
        endTime: "00:10",
      },
    ];

    const warnings = await reviewSamePositionFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(
      assignments.find((item) => item.id === "tr-supervisor-assignment")
        ?.staffId
    ).toBe(underused.id);
    expect(
      assignments.find((item) => item.id === "tw-ordinary-assignment")?.staffId
    ).toBe(frequent.id);
  });

  it("does not warn when qualified workers differ by fewer than two assignments", async () => {
    const { state, first, second } = frequencyState();
    const dates = ["2026-08-12", "2026-08-14"];
    state.history = dates.flatMap((date, index) => [
      record(first, date, index),
      record(second, date, index),
    ]);
    const assignments = [assignment(first)];

    const warnings = await reviewSamePositionFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(
      assignments[0]?.decisionTrace?.some(
        (decision) =>
          decision.ruleId === "position-frequency-review" &&
          decision.outcome === "fallback"
      )
    ).toBeFalsy();
  });

  it("records improvement without a warning when the current assignment uses a low-frequency worker", async () => {
    const { state, first, second } = frequencyState();
    state.history = [
      "2026-08-10",
      "2026-08-12",
      "2026-08-14",
      "2026-08-16",
    ].map((date, index) => record(first, date, index));
    const assignments = [assignment(second)];

    const warnings = await reviewSamePositionFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(assignments[0]?.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency-review",
          outcome: "selected",
          message: expect.stringContaining("差距正在改善"),
        }),
      ])
    );
  });

  it("alarms when a post-stage edit leaves an overused ordinary-priority worker in place", async () => {
    const { state, first } = frequencyState();
    state.history = ["2026-08-10", "2026-08-12", "2026-08-14"].map(
      (date, index) => record(first, date, index)
    );
    const edited = assignment(first);

    const warnings = await reviewSamePositionFrequency(
      defaultHighsSolver,
      state,
      [edited],
      DATE,
      new Set([edited.id])
    );

    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("本月承担4次")])
    );
    expect(edited.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency-review",
          outcome: "fallback",
        }),
      ])
    );
  });

  it("ignores unavailable workers when comparing the highest and lowest counts", async () => {
    const { state, first, second } = frequencyState();
    const unavailable = structuredClone(createDefaultState().staff[2]!);
    unavailable.status = "休假";
    unavailable.staffType = "常规";
    unavailable.nightShift = true;
    state.staff.push(unavailable);
    state.positionRules[0]!.qualifiedStaffIds.push(unavailable.id);
    const dates = ["2026-08-12", "2026-08-14"];
    state.history = dates.flatMap((date, index) => [
      record(first, date, index),
      record(second, date, index),
    ]);
    const assignments = [assignment(first)];

    const warnings = await reviewSamePositionFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(warnings).toEqual([]);
  });

  it("uses the current shift plus the previous seven archived workdays for warnings", () => {
    const { state, first, second } = frequencyState();
    const dates = [
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
    ];
    state.history = dates.map((date, index) =>
      index === 0
        ? record(first, date, index)
        : { ...record(second, date, index), position: "OTHER" }
    );
    const current = assignment(first);

    const assessment = assessPositionFrequencyAlert(
      state,
      current,
      "2026-08-02"
    );

    expect(
      assessment?.periods.find((period) => period.label === "最近8个工作日")
    ).toMatchObject({ assignedCount: 1, difference: 1 });
    expect(assessment?.needsAttention).toBe(false);
  });

  it("reuses the run frequency facts when recording alert evidence", async () => {
    const { state, first } = frequencyState();
    state.settings.positionRotationEnabled = true;
    const runFacts = createScheduleRunFacts(state, DATE);
    const stateWithoutHistoryReads = new Proxy(state, {
      get(target, property, receiver) {
        if (property === "history")
          throw new Error("frequency review rebuilt the history index");
        return Reflect.get(target, property, receiver);
      },
    });

    const warnings = await reviewSamePositionFrequency(
      defaultHighsSolver,
      stateWithoutHistoryReads,
      [assignment(first)],
      DATE,
      new Set(),
      runFacts
    );

    expect(warnings).toEqual([]);
  });

  it("rebuilds frequency facts when the cached date does not match", () => {
    const { state, first } = frequencyState();
    const staleFacts = createScheduleFrequencyFacts(state, "2026-08-17");
    const stateWithoutHistoryReads = new Proxy(state, {
      get(target, property, receiver) {
        if (property === "history")
          throw new Error("target date needs its own frequency index");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      assessPositionFrequencyAlert(
        stateWithoutHistoryReads,
        assignment(first),
        DATE,
        staleFacts
      )
    ).toThrow("target date needs its own frequency index");
  });
});

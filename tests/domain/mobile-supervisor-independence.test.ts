import { expect, it } from "vitest";
import {
  supervisorIndependenceScenario,
  beforeSupervisorSnapshot,
} from "../helpers/supervisor-independence-scenario";
import { finalizeMobileSupervisors } from "../../src/domain/assignments/ke166-supervisor-finalizer";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { generateSchedule } from "../helpers/generate-schedule";
import { occupiedSnapshot } from "../helpers/cross-flight-vacancy-scenario";
import { restoreIndependentMobileSupervisors } from "../../src/domain/coverage/mobile-supervisor-independence";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { assertDailyScheduleSafety } from "../../src/domain/kernel/daily-schedule-safety";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import type { Assignment } from "../../src/model";
import { schedulingDecision } from "../../src/domain/rules/schedule-rule-contract";

const DATE = "2026-11-18";

function linkedScenario(chain = false) {
  const state = supervisorIndependenceScenario();
  if (chain) {
    state.positionRules.find((r) => r.id === "fill-rule")!.qualifiedStaffIds = [
      "bridge",
    ];
    state.positionRules.find((r) => r.id === "source-rule")!.qualifiedStaffIds =
      ["bridge", "replacement"];
  }
  const rows = occupiedSnapshot(state);
  const source = rows.find((a) => a.position === "督导")!;
  const target = rows.find((a) => a.position === "H05")!;
  Object.assign(target, {
    staffId: source.staffId,
    staffName: source.staffName,
    workHours: 0,
    fatiguePoints: 0,
    supervisorSourceAssignmentId: source.id,
    supervisorFillRuleId: "configured-fill",
  });
  return { state, rows, source, target };
}

async function restore(
  state: ReturnType<typeof supervisorIndependenceScenario>,
  rows: Assignment[],
  locks = new Set<string>()
) {
  const prep = prepareSchedule(state, DATE, evaluateAutomaticHardConstraints);
  const safety = createScheduleSafetySession({
    phase: "final",
    state,
    date: DATE,
    runFacts: prep.runFacts,
  });
  await restoreIndependentMobileSupervisors({
    solver: defaultHighsSolver,
    state,
    assignments: rows,
    date: DATE,
    facts: prep.runFacts,
    lockedAssignmentIds: locks,
    validateAssignments: (planned) => {
      try {
        safety.assertAssignmentsSafe(planned);
        assertDailyScheduleSafety({
          state,
          date: DATE,
          assignments: planned,
          tasks: prep.tasks,
          evaluateEligibility: evaluateAutomaticHardConstraints,
          allowFinalizedConcurrency: true,
          halfRestFacts: prep.runFacts.halfRest,
        });
        return true;
      } catch (error) {
        if (!(error instanceof ScheduleGuardError)) throw error;
        return false;
      }
    },
  });
}

it.each([false, true])(
  "restores a recorded pair with a complete ordinary chain=%s and keeps the rotated supervisor",
  async (chain) => {
    const { state, rows, source } = linkedScenario(chain);
    source.decisionTrace = [
      schedulingDecision("position-rotation", "selected", "轮换后的督导"),
    ];
    await restore(state, rows);
    const supervisor = rows.find((a) => a.id === source.id)!;
    const target = rows.find((a) => a.position === "H05")!;
    expect(supervisor.staffId).toBe("supervisor");
    expect(
      supervisor.decisionTrace?.some((d) => d.ruleId === "position-rotation")
    ).toBe(true);
    expect(target.staffId).toBe(chain ? "bridge" : "replacement");
    expect(target.supervisorSourceAssignmentId).toBeUndefined();
    expect(target.supervisorFillRuleId).toBeUndefined();
    expect(target.workHours).toBe(2);
    expect(target.fatiguePoints).toBe(2);
    expect(rows.every((a) => a.status === "assigned")).toBe(true);
  }
);

it("also splits a generic counter pair without a configured relation", async () => {
  const { state, rows, target } = linkedScenario();
  state.settings.mobileSupervisorFillRules = [];
  delete target.supervisorFillRuleId;
  await restore(state, rows);
  expect(rows.find((a) => a.position === "H05")?.staffId).toBe("replacement");
  expect(rows.some((a) => a.supervisorSourceAssignmentId)).toBe(false);
});

it("rebuilds the reused guide from the ordinary counter after splitting its supervisor link", async () => {
  const { state, rows, source, target } = linkedScenario();
  const rule = {
    ...state.positionRules[1]!,
    id: "guide-rule",
    name: "引导",
    category: "引导" as const,
    qualifiedStaffIds: [],
  };
  state.positionRules = [
    state.positionRules[0]!,
    state.positionRules[2]!,
    state.positionRules[1]!,
    rule,
  ];
  rows.push({
    ...target,
    id: "guide-row",
    positionRuleId: rule.id,
    position: rule.name,
    supervisorSourceAssignmentId: undefined,
    supervisorFillRuleId: undefined,
    staffId: source.staffId,
    staffName: source.staffName,
  });
  await restore(state, rows);
  const guide = rows.find((a) => a.id === "guide-row")!;
  expect(guide.staffId).toBe("replacement");
  expect(guide.workHours).toBe(0);
  expect(guide.fatiguePoints).toBe(0);
  expect(rows.find((a) => a.id === target.id)?.workHours).toBe(2);
});

it("tries direct replacements across all flights before a longer chain consumes the only spare", async () => {
  const { state, rows, source } = linkedScenario();
  state.positionRules
    .find((r) => r.id === "source-rule")!
    .qualifiedStaffIds.push("replacement");
  state.staff.push({
    ...state.staff[0]!,
    id: "other-supervisor",
    name: "other-supervisor",
  });
  state.flights.push({
    ...state.flights[0]!,
    id: "other-flight",
    flightNo: "CD200",
  });
  state.positionRules.push(
    {
      ...state.positionRules[0]!,
      id: "other-source",
      flightNo: "CD200",
      qualifiedStaffIds: ["other-supervisor"],
    },
    {
      ...state.positionRules[1]!,
      id: "other-target",
      flightNo: "CD200",
      qualifiedStaffIds: ["bridge"],
    }
  );
  state.settings.mobileSupervisorFillRules.push({
    ...state.settings.mobileSupervisorFillRules[0]!,
    id: "other-fill",
    sourceFlightNo: "CD200",
    targetFlightNo: "CD200",
  });
  const otherSource = {
    ...source,
    id: "other-source",
    positionRuleId: "other-source",
    flightId: "other-flight",
    flightNo: "CD200",
    staffId: "other-supervisor",
    staffName: "other-supervisor",
  };
  const otherTarget = {
    ...rows.find((a) => a.position === "H05")!,
    id: "other-target",
    positionRuleId: "other-target",
    flightId: "other-flight",
    flightNo: "CD200",
    staffId: "other-supervisor",
    staffName: "other-supervisor",
    supervisorSourceAssignmentId: otherSource.id,
    supervisorFillRuleId: "other-fill",
  };
  rows.unshift(otherSource, otherTarget);
  await restore(state, rows);
  expect(rows.find((a) => a.id === "fill-rule")?.staffId).toBe("replacement");
  expect(
    rows.find((a) => a.id === "fill-rule")?.supervisorSourceAssignmentId
  ).toBeUndefined();
  expect(
    rows.find((a) => a.id === "other-target")?.supervisorSourceAssignmentId
  ).toBe(otherSource.id);
  expect(rows.every((a) => a.status === "assigned")).toBe(true);
});

it("keeps the pair when half rest bans its only ordinary replacement", async () => {
  const { state, rows } = linkedScenario();
  const before = structuredClone(rows);
  const prep = prepareSchedule(state, DATE, evaluateAutomaticHardConstraints, {
    halfRestStaffIds: ["replacement"],
    halfRestModes: { replacement: "late-start" },
  });
  await restoreIndependentMobileSupervisors({
    state,
    assignments: rows,
    date: DATE,
    facts: prep.runFacts,
    solver: defaultHighsSolver,
    lockedAssignmentIds: new Set(),
    validateAssignments: () => true,
  });
  expect(rows).toEqual(before);
});

it.each([
  "locked-source",
  "locked-target",
  "locked-chain",
  "manual-source",
  "manual-target",
  "manual-edit",
  "unqualified",
  "team-leader",
  "sick",
  "exclusion",
  "hours",
  "no-spare",
])(
  "keeps the whole original pair and coverage when blocked by %s",
  async (boundary) => {
    const { state, rows, source, target } = linkedScenario(
      boundary === "locked-chain"
    );
    const locks = new Set<string>();
    if (boundary === "locked-source") locks.add(source.id);
    if (boundary === "locked-target") locks.add(target.id);
    if (boundary === "locked-chain") locks.add("source-rule");
    if (boundary === "manual-source") state.positionRules[0]!.manual = true;
    if (boundary === "manual-target") target.status = "manual";
    if (boundary === "manual-edit")
      target.countBaseline = {
        staffId: "replacement",
        staffName: "replacement",
      };
    if (boundary === "unqualified")
      state.positionRules.find((r) => r.id === "fill-rule")!.qualifiedStaffIds =
        [];
    if (boundary === "team-leader")
      state.staff.find((p) => p.id === "replacement")!.teamLeader = true;
    if (boundary === "sick")
      state.staff.find((p) => p.id === "replacement")!.status = "病假";
    if (boundary === "exclusion")
      state.settings.sameFlightStaffExclusions = [
        {
          id: "excluded",
          enabled: true,
          flightNo: "AB100",
          staffIds: ["replacement", "supervisor"],
        },
      ];
    if (boundary === "hours") state.settings.maxDailyHours = 1;
    if (boundary === "no-spare")
      state.staff = state.staff.filter((p) => p.id !== "replacement");
    const before = structuredClone(rows);
    await restore(state, rows, locks);
    expect(rows).toEqual(before);
  }
);

it.each(["timeout", "final-rejection"])(
  "preserves the snapshot atomically after %s",
  async (failure) => {
    const { state, rows } = linkedScenario(true);
    const before = structuredClone(rows);
    const prep = prepareSchedule(state, DATE, evaluateAutomaticHardConstraints);
    await restoreIndependentMobileSupervisors({
      state,
      assignments: rows,
      date: DATE,
      facts: prep.runFacts,
      lockedAssignmentIds: new Set(),
      validateAssignments: () => false,
      solver:
        failure === "timeout"
          ? {
              solve: async () => ({
                termination: "timed-out",
                selectedVariableIds: new Set<string>(),
                objectiveValues: new Map<string, number>(),
              }),
            }
          : defaultHighsSolver,
    });
    expect(rows).toEqual(before);
  }
);

it("frees an occupied qualified supervisor by assigning a counter-only spare first", async () => {
  const state = supervisorIndependenceScenario();
  const rows = beforeSupervisorSnapshot(state);
  await finalizeMobileSupervisors({
    solver: defaultHighsSolver,
    state,
    date: DATE,
    assignments: rows,
    preparation: prepareSchedule(state, DATE, evaluateAutomaticHardConstraints),
    lockedAssignmentIds: new Set(),
  });
  const source = rows.find((a) => a.position === "督导")!;
  expect(source.staffId).toBe("supervisor");
  expect(rows.find((a) => a.position === "H07")?.staffId).toBe("bridge");
  expect(rows.some((a) => a.supervisorSourceAssignmentId)).toBe(false);
  expect(rows.every((a) => a.status === "assigned")).toBe(true);
});

it("keeps independent supervisors and all counters in the complete generated result", async () => {
  const state = supervisorIndependenceScenario();
  const result = await generateSchedule(state, DATE);
  expect(result.assignments.every((a) => a.status === "assigned")).toBe(true);
  expect(result.assignments.some((a) => a.supervisorSourceAssignmentId)).toBe(
    false
  );
  expect(result.assignments.find((a) => a.position === "督导")?.staffId).toBe(
    "supervisor"
  );
});

import { describe, expect, it } from "vitest";

import { createDefaultScheduleSettings } from "../../src/domain/rules/schedule-settings";
import {
  SCHEDULE_PROGRESS_STAGES,
  visibleScheduleProgressStep,
} from "../../src/domain/kernel/schedule-progress";
import {
  coverageHookPlan,
  plannedScheduleProgress,
  postScheduleReviewPlan,
  runScheduleMutationPlan,
} from "../../src/domain/kernel/schedule-pipeline";
import { createSchedulingScenario } from "../helpers/scheduling-scenario";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { createScheduleLedger } from "../../src/domain/kernel/schedule-ledger";
import {
  createDefaultScheduleGuards,
  ScheduleGuardError,
} from "../../src/domain/kernel/schedule-guard";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import type { Assignment } from "../../src/model";
import type { HalfRestFacts } from "../../src/domain/rules/half-rest";

describe("schedule pipeline contract", () => {
  it("does not include automatic concurrent team-leader supervision", () => {
    expect(
      coverageHookPlan(createDefaultScheduleSettings()).map(
        (step) => step.ruleId
      )
    ).not.toContain("team-leader-concurrent-supervision");
  });

  it("withdraws an illegal post-stage proposal and keeps the legal schedule", async () => {
    const state = createSchedulingScenario();
    const halfRestFacts: HalfRestFacts = {
      requestedStaffIds: ["half-rest-worker"],
      activeStaffIds: new Set(["half-rest-worker"]),
      minimumWorkStaffIds: new Set<string>(),
      ignoredWarnings: [],
      modesByStaffId: new Map([["half-rest-worker", "late-start" as const]]),
      earlyFinishStaffIds: new Set<string>(),
      lateStartStaffIds: new Set(["half-rest-worker"]),
    };
    const legal: Assignment = {
      id: "pipeline-legal",
      flightId: "afternoon-flight",
      flightNo: "A100",
      positionRuleId: "rule-1",
      position: "G01",
      staffId: "half-rest-worker",
      staffName: "半休人员",
      startTime: "13:00",
      endTime: "15:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const illegal = {
      ...legal,
      id: "pipeline-illegal",
      startTime: "09:00",
      endTime: "11:00",
    };
    const runFacts = {
      ...createScheduleRunFacts(state, "2026-09-12"),
      halfRest: halfRestFacts,
    };
    const ledger = createScheduleLedger([legal], {
      safetySession: createScheduleSafetySession({
        phase: "partial",
        state,
        date: "2026-09-12",
        runFacts,
        guards: createDefaultScheduleGuards(),
      }),
    });
    const context = {
      solver: {
        solve: async () => {
          throw new Error("not called");
        },
      },
      state,
      ledger,
      date: "2026-09-12",
      lockedAssignmentIds: new Set<string>(),
      runFacts,
      flights: [],
      displayRulesByFlight: new Map(),
      finalizeMobileSupervisors: async () => undefined,
    };

    const warnings = await runScheduleMutationPlan(context, [
      {
        ruleId: "half-rest-morning",
        label: "test",
        stage: "test-illegal-proposal",
        executor: {
          kind: "coverage",
          id: "test-illegal-proposal",
          pass: "primary",
          execute: async () => {
            ledger.commit({
              type: "replace",
              assignments: [{ ...legal, staffName: "中途改动" }],
            });
            context.lockedAssignmentIds.add("new-lock");
            throw new ScheduleGuardError([
              {
                ruleId: "half-rest",
                assignmentId: illegal.id,
                message: "上午半休人员不得安排12点前岗位",
              },
            ]);
          },
        },
      },
      {
        ruleId: "half-rest-morning",
        label: "后续岗位",
        stage: "following-stage",
        executor: {
          kind: "coverage",
          id: "following-stage",
          pass: "primary",
          execute: async () => ({ warnings: ["其他岗位继续处理"] }),
        },
      },
    ]);
    expect(warnings.join("；")).toContain("保留调整前的安排");
    expect(warnings).toContain("其他岗位继续处理");
    expect(context.lockedAssignmentIds.size).toBe(0);
    expect(ledger.snapshot()).toEqual([legal]);
  });

  it("keeps post-schedule reviews in the documented order", () => {
    expect(
      postScheduleReviewPlan(createDefaultScheduleSettings()).map(
        (step) => step.stage
      )
    ).toEqual([
      "late-priority-frequency",
      "position-frequency",
      "late-shift-recovery",
      "late-shift-cutoff",
      "position-rotation",
      "mobile-supervisor-finalize",
      "post-mobile-supervisor-late-priority-frequency-validation",
      "post-mobile-supervisor-frequency-validation",
      "post-mobile-supervisor-rotation-validation",
    ]);
  });

  it("owns the visible progress metadata for every review that reports progress", () => {
    const plan = postScheduleReviewPlan(createDefaultScheduleSettings());
    const visible = plan.flatMap((step) => {
      const progress = visibleScheduleProgressStep(step.stage);
      return progress ? [progress] : [];
    });

    expect(visible.map((step) => step.percent)).toEqual([
      65, 75, 82, 85, 92, 95, 96, 98,
    ]);
    expect(visible.every((step) => Boolean(step.label.trim()))).toBe(true);
    expect(new Set(plan.map((step) => step.stage)).size).toBe(plan.length);
    expect(SCHEDULE_PROGRESS_STAGES.slice(3, -1)).toEqual(
      visible.map((step) => step.stage)
    );
  });

  it("projects post reviews from the fixed hook order and named settings", () => {
    const settings = createDefaultScheduleSettings();
    settings.lateShiftRecoveryEnabled = false;

    const plan = postScheduleReviewPlan(settings);

    expect(plan.map((step) => step.stage)).not.toContain("late-shift-cutoff");
    expect(plan.map((step) => step.stage)[0]).toBe("late-priority-frequency");
    expect(plan.map((step) => step.stage)).toEqual(
      expect.arrayContaining([
        "mobile-supervisor-finalize",
        "post-mobile-supervisor-late-priority-frequency-validation",
        "post-mobile-supervisor-frequency-validation",
        "post-mobile-supervisor-rotation-validation",
      ])
    );
  });

  it("shows only the progress tasks that the enabled hook plan will execute", () => {
    const settings = createDefaultScheduleSettings();
    settings.lateShiftRecoveryEnabled = false;

    const stages = plannedScheduleProgress(
      settings,
      [{ flightNo: "KE166" }],
      [{ flightNo: "KE166", category: "机动督导" }]
    ).map((step) => step.stage);

    expect(stages).not.toContain("late-shift-cutoff");
    expect(stages.slice(0, 3)).toEqual(["prepare", "optimize", "assign"]);
    expect(stages.at(-1)).toBe("complete");
  });

  it("omits supervisor follow-up tasks when the current flights have no mobile supervisor", () => {
    const stages = plannedScheduleProgress(
      createDefaultScheduleSettings(),
      [{ flightNo: "TR121" }],
      [{ flightNo: "TR121", category: "常规" }]
    ).map((step) => step.stage);

    expect(stages).not.toContain("post-mobile-supervisor-frequency-validation");
    expect(stages).not.toContain(
      "post-mobile-supervisor-late-priority-frequency-validation"
    );
    expect(stages).not.toContain("post-mobile-supervisor-rotation-validation");
  });
});

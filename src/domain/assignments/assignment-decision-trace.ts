import type { Assignment, Staff } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  schedulingDecision,
  type SchedulingDecision,
  type SchedulingRuleId,
} from "../rules/schedule-rule-contract";
import type { CandidatePriority } from "../candidates/candidate-priority";
import {
  firstDifferentCandidateRulePlan,
  type CandidateRulePlanItem,
} from "../rules/candidate-rule-plan";
import {
  configuredDutyTaskPriority,
  dutyHardConstraintReason,
} from "./duty-assignment";
import { comparePreviousWorkdayLoad } from "../shared/previous-workday-load";
import { nextWorkdayRecoveryOverrideReason } from "./schedule-decision-notes";
import {
  isHighLoadPosition,
  lateShiftCutoffPriority,
  lateShiftRecoveryRisk,
  positionTransitionInsertionCost,
} from "../reviews/schedule-protection";
import { isLateEndingWork } from "../reviews/cross-day-recovery";
import { latePriorityFlightInScope } from "../statistics/late-priority-flight-scope";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import { assignmentWarningMessage } from "../reviews/schedule-warning-message";
import {
  isKe166MobileSupervisor,
  type AssignmentTask,
} from "../flights/schedule-tasks";
import { tr121H02CooldownProfile } from "../rules/tr121-h02-cooldown";

export interface AssignmentDecisionTraceContext {
  state: ScheduleGenerationFacts;
  date: string;
  assignments: Assignment[];
  task: AssignmentTask;
  selected: Staff;
  runnerUp?: Staff;
  candidates: readonly Staff[];
  candidatePriorities: ReadonlyMap<string, CandidatePriority>;
  candidateRulePlan: readonly CandidateRulePlanItem[];
  decisiveCandidateRule: CandidateRulePlanItem | null;
  runFacts: ScheduleRunFacts;
  dutyStaffId: string | null;
  isDutyTarget: boolean;
  hasAssignedDutyLateTask: boolean;
  finalizingKe166Supervisor: boolean;
}

function appendReservedAssignmentDecisions(
  trace: SchedulingDecision[],
  context: AssignmentDecisionTraceContext
): void {
  const {
    state,
    task,
    selected,
    dutyStaffId,
    isDutyTarget,
    hasAssignedDutyLateTask,
    finalizingKe166Supervisor,
  } = context;
  const { flight, rule } = task;
  if (finalizingKe166Supervisor) {
    trace.push(
      schedulingDecision(
        "ke166-supervisor",
        "selected",
        `${selected.name}在柜台排班与重点岗位轮换完成后独立担任${flight.flightNo}/${rule.name}`
      )
    );
  }
  const configuredPriority = configuredDutyTaskPriority(state, task);
  if (
    !dutyStaffId ||
    configuredPriority < 0 ||
    !isDutyTarget ||
    hasAssignedDutyLateTask
  )
    return;
  const hardReason = dutyHardConstraintReason(state, dutyStaffId, task);
  trace.push(
    selected.id === dutyStaffId
      ? schedulingDecision(
          "duty-position",
          "selected",
          `值班人员${selected.name}按优先级第${configuredPriority + 1}项锁定${flight.flightNo}/${rule.name}`
        )
      : schedulingDecision(
          "duty-position",
          "blocked",
          hardReason ??
            `值班人员未通过${flight.flightNo}/${rule.name}的时段、工时或衔接检查`
        )
  );
}

function appendProtectionFallbacks(
  trace: SchedulingDecision[],
  context: AssignmentDecisionTraceContext
): void {
  const {
    state,
    date,
    assignments,
    task,
    selected,
    dutyStaffId,
    isDutyTarget,
    runFacts,
  } = context;
  const { flight, rule } = task;
  const ke166 = isKe166MobileSupervisor(flight, rule, state);
  if (
    selected.id === dutyStaffId &&
    isDutyTarget &&
    positionTransitionInsertionCost(
      assignments,
      selected.id,
      task,
      state,
      "forbid"
    ) > 0
  ) {
    trace.push(
      schedulingDecision(
        "position-transition",
        "fallback",
        assignmentWarningMessage({
          staffName: selected.name,
          fact: `承担${flight.flightNo}/${rule.name}时未满足岗位衔接要求`,
          reasons: ["值班岗位锁定优先"],
          decision: "值班安排优先",
          result: "保留原安排",
        })
      )
    );
  }
  const recovery = lateShiftRecoveryRisk(
    state,
    selected.id,
    {
      ...flight,
      position: rule.name,
      remark: rule.remark,
      fatiguePoints: rule.fatiguePoints,
    },
    date,
    runFacts.crossDayRecovery
  );
  if (recovery.protectedMorningTarget || recovery.protectedLatePriorityTarget) {
    const reason = nextWorkdayRecoveryOverrideReason(
      state,
      assignments,
      selected,
      task,
      dutyStaffId,
      isDutyTarget,
      ke166,
      recovery.protectedMorningTarget
    );
    trace.push(
      schedulingDecision(
        "late-shift-recovery",
        "fallback",
        assignmentWarningMessage({
          staffName: selected.name,
          fact: `上一班较晚结束，本班仍承担${flight.flightNo}/${rule.name}`,
          reasons: [reason],
        })
      )
    );
  }
  const cutoff = lateShiftCutoffPriority(
    state,
    selected.id,
    flight,
    date,
    runFacts.crossDayRecovery
  );
  if (cutoff.disposition !== "after-cutoff") return;
  const reason = nextWorkdayRecoveryOverrideReason(
    state,
    assignments,
    selected,
    task,
    dutyStaffId,
    isDutyTarget,
    ke166,
    false
  );
  trace.push(
    schedulingDecision(
      "late-shift-cutoff",
      "fallback",
      assignmentWarningMessage({
        staffName: selected.name,
        fact: `上一班较晚结束，本班仍在截止时间后承担${flight.flightNo}/${rule.name}`,
        reasons: [reason],
        result: "保留原安排，未能提前下班",
      })
    )
  );
}

function appendTr121H02CooldownFallback(
  trace: SchedulingDecision[],
  context: AssignmentDecisionTraceContext
): void {
  const { state, date, task, selected, runFacts } = context;
  const profile = tr121H02CooldownProfile(
    state,
    selected.id,
    task.flight.flightNo,
    task.rule,
    date,
    runFacts.scheduleFrequency
  );
  if (!profile.inCooldown) return;
  trace.push(
    schedulingDecision(
      "tr121-h02-cooldown",
      "fallback",
      `${selected.name}最近工作班已承担${task.flight.flightNo}/${task.rule.name}，本次因岗位完整性需要突破冷却，距冷却结束还剩${profile.remainingWorkdays}个工作班`
    )
  );
}

function appendLateShiftPositionReliefDecision(
  trace: SchedulingDecision[],
  context: AssignmentDecisionTraceContext
): void {
  const { state, assignments, task, selected, runFacts } = context;
  if (
    !state.settings.lateShiftRecoveryEnabled ||
    !runFacts.crossDayRecovery.previousWorkday.scopedProtectedStaffIds.has(
      selected.id
    ) ||
    !latePriorityFlightInScope(
      state.settings.latePriorityFlightNumbers,
      task.flight.flightNo,
      state
    ) ||
    !isLateEndingWork(task.flight, state)
  )
    return;
  const previousLate =
    runFacts.crossDayRecovery.previousWorkday.protectedRecords
      .filter(
        (record) =>
          record.staffId === selected.id &&
          latePriorityFlightInScope(
            state.settings.latePriorityFlightNumbers,
            record.flightNo,
            state,
            record.date
          )
      )
      .map((record) => `${record.flightNo}/${record.position}`)
      .join("、");
  const assignedLateFatigues = assignments
    .filter(
      (assignment) =>
        assignment.staffId === selected.id &&
        latePriorityFlightInScope(
          state.settings.latePriorityFlightNumbers,
          assignment.flightNo,
          state
        ) &&
        isLateEndingWork(assignment, state)
    )
    .map((assignment) => assignment.fatiguePoints);
  const minimumFatigue = Math.min(
    task.rule.fatiguePoints,
    ...assignedLateFatigues
  );
  const isLightest = task.rule.fatiguePoints <= minimumFatigue;
  trace.push(
    schedulingDecision(
      "late-shift-position-relief",
      isLightest ? "selected" : "fallback",
      isLightest
        ? `${selected.name}上一班承担${previousLate || "已勾选末班重点岗位"}；本班晚班必须工作，已优先选择${task.flight.flightNo}/${task.rule.name}（${task.rule.fatiguePoints}疲劳点）`
        : `${selected.name}上一班承担${previousLate || "已勾选末班重点岗位"}；本班仍承担${task.flight.flightNo}/${task.rule.name}，更轻岗位未形成完整安全方案或被更高优先级规则占用`
    )
  );
}

function appendDecisiveRule(
  trace: SchedulingDecision[],
  context: AssignmentDecisionTraceContext
): void {
  const { selected, runnerUp, decisiveCandidateRule } = context;
  if (
    !runnerUp ||
    !decisiveCandidateRule ||
    trace.some((decision) => decision.ruleId === decisiveCandidateRule.id)
  )
    return;
  const message = `${selected.name}在“${decisiveCandidateRule.label}”判断中优先于${runnerUp.name}`;
  trace.push(
    schedulingDecision(
      decisiveCandidateRule.id as SchedulingRuleId,
      "selected",
      message
    )
  );
}

function appendCrossWorkdayFallback(
  trace: SchedulingDecision[],
  context: AssignmentDecisionTraceContext
): void {
  const {
    state,
    task,
    selected,
    candidates,
    candidatePriorities,
    candidateRulePlan,
  } = context;
  if (!isHighLoadPosition(task.rule.fatiguePoints, task.rule.remark, state))
    return;
  const selectedLoad = candidatePriorities.get(
    selected.id
  )?.previousWorkdayLoad;
  const lighter = selectedLoad
    ? candidates.find((person) => {
        const profile = candidatePriorities.get(person.id);
        return (
          profile &&
          comparePreviousWorkdayLoad(
            profile.previousWorkdayLoad,
            selectedLoad
          ) < 0
        );
      })
    : undefined;
  const blockingRule = lighter
    ? firstDifferentCandidateRulePlan(
        candidateRulePlan,
        task,
        selected,
        candidatePriorities.get(selected.id)!,
        lighter,
        candidatePriorities.get(lighter.id)!
      )
    : null;
  if (!lighter || !blockingRule || blockingRule.id === "cross-workday-load")
    return;
  trace.push(
    schedulingDecision(
      "cross-workday-load",
      "fallback",
      `跨工作班负荷互补未落实：${selected.name}上一班负荷高于${lighter.name}，本班仍承担${task.flight.flightNo}/${task.rule.name}；${blockingRule.label}优先。`
    )
  );
}

export function buildAssignmentDecisionTrace(
  context: AssignmentDecisionTraceContext
): SchedulingDecision[] {
  const trace: SchedulingDecision[] = [];
  appendReservedAssignmentDecisions(trace, context);
  appendProtectionFallbacks(trace, context);
  appendTr121H02CooldownFallback(trace, context);
  appendLateShiftPositionReliefDecision(trace, context);
  appendDecisiveRule(trace, context);
  appendCrossWorkdayFallback(trace, context);
  return trace;
}

import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { diagnoseBaseAssignmentEligibility } from "../candidates/assignment-eligibility";
import { isStrictNextWorkdayRecoveryTarget } from "../reviews/cross-day-recovery";
import {
  isPreNoonFlight,
  type AssignmentTask,
} from "../flights/schedule-tasks";
import type { LinearConstraint } from "../solver/solver-port";
import type { DailyScheduleModel } from "./daily-schedule-model";
import type { SchedulePreparation } from "./schedule-preparation";

export interface DailyScheduleFailureDiagnosticsOptions {
  state: ScheduleGenerationFacts;
  preparation: SchedulePreparation;
  model: DailyScheduleModel;
}

function taskLabel(task: AssignmentTask): string {
  return `${task.flight.flightNo}/${task.rule.name}`;
}

function isPairBlocked(
  constraints: readonly LinearConstraint[],
  leftId: string,
  rightId: string
): boolean {
  return constraints.some(
    (constraint) =>
      constraint.upperBound === 1 &&
      constraint.terms.some((term) => term.variableId === leftId) &&
      constraint.terms.some((term) => term.variableId === rightId)
  );
}

function strictTaskDiagnostics({
  state,
  preparation,
  model,
}: DailyScheduleFailureDiagnosticsOptions): string[] {
  const protectedStaffIds =
    preparation.runFacts.crossDayRecovery.previousWorkday.protectedStaffIds;
  const strictTasks = preparation.tasks.filter((task) =>
    isStrictNextWorkdayRecoveryTarget(state, {
      flightNo: task.flight.flightNo,
      position: task.rule.name,
      remark: task.rule.remark,
    })
  );
  const diagnostics: string[] = [];
  const choicesByTask = new Map(
    strictTasks.map((task) => [
      task.key,
      model.staffChoices.filter((choice) => choice.task.key === task.key),
    ])
  );

  for (const task of strictTasks) {
    const baseEligible = state.staff.filter(
      (person) =>
        diagnoseBaseAssignmentEligibility(state, task.flight, task.rule, person)
          .eligible
    );
    const choices = choicesByTask.get(task.key) ?? [];
    if (choices.length > 0) continue;
    const protectedCount = baseEligible.filter((person) =>
      protectedStaffIds.has(person.id)
    ).length;
    const reason =
      baseEligible.length === 0
        ? "没有人员同时满足在岗状态、岗位资质和夜班能力"
        : protectedCount === baseEligible.length
          ? `基础合格的 ${baseEligible.length} 人全部被上一班末班重点岗位避让排除`
          : `基础合格 ${baseEligible.length} 人，但严格恢复过滤后剩余 0 人`;
    diagnostics.push(
      `${taskLabel(task)}：${reason}。按严格次班恢复设置，这个岗位允许留空；单凭这项不能说明整张班表为什么计算失败，需要检查程序。`
    );
  }

  const blockingConstraints = model.problem.constraints.filter(
    (constraint) =>
      constraint.upperBound === 1 &&
      (constraint.id.startsWith("overlap:") ||
        constraint.id.startsWith("minimum-transition:") ||
        constraint.id.startsWith("same-flight:"))
  );
  for (let leftIndex = 0; leftIndex < strictTasks.length; leftIndex += 1) {
    const left = strictTasks[leftIndex]!;
    const leftChoices = choicesByTask.get(left.key) ?? [];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < strictTasks.length;
      rightIndex += 1
    ) {
      const right = strictTasks[rightIndex]!;
      const rightChoices = choicesByTask.get(right.key) ?? [];
      if (!leftChoices.length || !rightChoices.length) continue;
      const compatiblePair = leftChoices.some((leftChoice) =>
        rightChoices.some(
          (rightChoice) =>
            leftChoice.person.id !== rightChoice.person.id ||
            !isPairBlocked(blockingConstraints, leftChoice.id, rightChoice.id)
        )
      );
      if (compatiblePair) continue;
      diagnostics.push(
        `${taskLabel(left)} 与 ${taskLabel(right)}：现有候选无法同时承担，可能有时间冲突、航班之间间隔不足或同航班重复占位。岗位允许留空，单凭这项不能说明整张班表为什么失败，需要检查程序。`
      );
    }
  }

  return diagnostics;
}

function halfRestDiagnostics({
  state,
  preparation,
  model,
}: DailyScheduleFailureDiagnosticsOptions): string[] {
  const noAllowedPositionDiagnostics: string[] = [];
  const workersWithChoices: string[] = [];
  for (const staffId of preparation.runFacts.halfRest.minimumWorkStaffIds) {
    const person = state.staff.find((item) => item.id === staffId);
    if (!person) continue;
    const mode =
      preparation.runFacts.halfRest.modesByStaffId.get(staffId) ??
      "early-finish";
    const targetChoices = model.staffChoices.filter(
      (choice) =>
        choice.person.id === staffId &&
        (mode === "late-start"
          ? !isPreNoonFlight(choice.task.flight)
          : isPreNoonFlight(choice.task.flight))
    );
    if (targetChoices.length === 0) {
      const restPeriod = mode === "late-start" ? "上午" : "下午";
      const workPeriod = mode === "late-start" ? "下午" : "上午";
      noAllowedPositionDiagnostics.push(
        `${person.name}选择了${restPeriod}半休，当前${workPeriod}没有能上的岗位，允许当天无岗。这不会单独阻止整张班表生成；本次计算失败还需要检查程序。`
      );
    } else {
      workersWithChoices.push(
        `${person.name}（${mode === "late-start" ? "上午" : "下午"}半休）`
      );
    }
  }
  if (noAllowedPositionDiagnostics.length) return noAllowedPositionDiagnostics;
  if (!workersWithChoices.length) return [];
  return [
    `${workersWithChoices.join("、")}在可上班的半天有候选岗位；半休允许无岗，不能据此推断计算失败原因，需要检查程序。`,
  ];
}

function strictCapacityDiagnostics({
  state,
  preparation,
  model,
}: DailyScheduleFailureDiagnosticsOptions): string[] {
  const strictTasks = preparation.tasks.filter((task) =>
    isStrictNextWorkdayRecoveryTarget(state, {
      flightNo: task.flight.flightNo,
      position: task.rule.name,
      remark: task.rule.remark,
    })
  );
  const diagnostics: string[] = [];
  for (const person of state.staff) {
    const choices = strictTasks.flatMap((task) =>
      model.staffChoices.filter(
        (choice) =>
          choice.task.key === task.key && choice.person.id === person.id
      )
    );
    if (
      choices.length < 2 ||
      choices.some(
        (choice) =>
          model.staffChoices.filter(
            (candidate) => candidate.task.key === choice.task.key
          ).length !== 1
      )
    )
      continue;
    const totalHours = choices.reduce(
      (sum, choice) => sum + choice.workHours,
      0
    );
    if (totalHours <= state.settings.maxDailyHours) continue;
    const labels = [
      ...new Set(choices.map((choice) => taskLabel(choice.task))),
    ];
    diagnostics.push(
      `${labels.join("、")}：只有${person.name}可用，合计 ${totalHours.toFixed(2)} 小时会超过每日 ${state.settings.maxDailyHours} 小时上限。可核对合格人员、时段和工时上限配置；岗位允许留空，这不应单独导致整班失败。`
    );
  }
  return diagnostics;
}

export function diagnoseDailyScheduleFailure(
  options: DailyScheduleFailureDiagnosticsOptions
): string[] {
  const diagnostics = [
    ...halfRestDiagnostics(options),
    ...strictTaskDiagnostics(options),
    ...strictCapacityDiagnostics(options),
  ];
  if (diagnostics.length) return [...new Set(diagnostics)].slice(0, 4);

  const taskWithNoBaseCandidate = options.preparation.tasks.find(
    (task) => (options.preparation.eligibleCounts.get(task.key) ?? 0) === 0
  );
  if (taskWithNoBaseCandidate) {
    return [
      `${taskLabel(taskWithNoBaseCandidate)}：没有人员同时满足在岗状态、岗位资质和夜班能力；普通岗位允许显示空缺，但请检查人员状态、岗位资质和夜班能力配置。`,
    ];
  }
  return [
    "尚未查明计算失败原因。岗位允许留空，局部缺人或时间冲突不应单独阻止整张班表；请导出诊断记录交给开发人员检查程序。",
  ];
}

import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import {
  isMobileSupervisor,
  type AssignmentTask,
} from "../flights/schedule-tasks";
import { evaluateAutomaticHardConstraints } from "../rules/built-in-rule-registry";
import { halfRestPeriodViolation } from "../rules/half-rest";
import {
  DAILY_FLIGHT_COUNT_BALANCE_VACANCY_NOTE,
  NO_QUALIFIED_CANDIDATE_VACANCY_NOTE,
} from "../assignments/vacancy-evidence";

/** Run-local evidence emitted when the model creates a reservation constraint.
 * This is diagnostic input only; it never participates in assignment decisions. */
export interface CrossFlightPriorityReservation {
  taskKey: string;
  staffId: string;
  priorityFlightNo: string;
  protectedTaskKey: string;
  alternativeStaffId: string;
}

export interface VacancyDiagnosticFacts {
  strictRecoveryExcludedStaffIdsByTask: ReadonlyMap<string, readonly string[]>;
  crossFlightPriorityReservations: readonly CrossFlightPriorityReservation[];
}

/** Recheck direct insertion against the final rows. These facts do not prove
 * that a multi-person rearrangement is impossible. Keep that limit explicit. */
export function refreshVacancyDiagnostics(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  tasks: readonly AssignmentTask[],
  runFacts: ScheduleRunFacts,
  facts?: VacancyDiagnosticFacts
): void {
  const selected = new Set(
    assignments
      .filter((a) => a.status === "assigned" && a.staffId)
      .map((a) => `${a.flightId}:${a.positionRuleId}:${a.staffId}`)
  );
  for (const assignment of assignments) {
    if (
      assignment.status === "assigned" &&
      assignment.systemNotes?.[0]?.startsWith("空岗：")
    ) {
      const end = assignment.systemNotes.findIndex((note) =>
        note.startsWith("以上为本次候选限制")
      );
      assignment.systemNotes =
        end >= 0 ? assignment.systemNotes.slice(end + 1) : [];
      if (!assignment.systemNotes.length) delete assignment.systemNotes;
    }
    if (assignment.status !== "unfilled") continue;
    const task = tasks.find(
      (t) =>
        t.flight.id === assignment.flightId &&
        t.rule.id === assignment.positionRuleId
    );
    if (!task) continue; // Passive/manual rows retain their own factual explanation.
    const groups = new Map<string, string[]>();
    const add = (rule: string, detail: string) =>
      groups.set(rule, [...(groups.get(rule) ?? []), detail]);
    const people = state.staff.filter((p) =>
      task.rule.qualifiedStaffIds.includes(p.id)
    );
    for (const person of people) {
      const halfRest = halfRestPeriodViolation({
        facts: runFacts.halfRest,
        staffId: person.id,
        startTime: task.flight.startTime,
      });
      if (halfRest) {
        add(
          "半休时段",
          `${person.name}：${halfRest}，目标开始时间 ${task.flight.startTime}`
        );
        continue;
      }
      if (
        facts?.strictRecoveryExcludedStaffIdsByTask
          .get(task.key)
          ?.includes(person.id)
      ) {
        const records =
          runFacts.crossDayRecovery.previousWorkday.protectedRecords.filter(
            (r) => r.staffId === person.id
          );
        add(
          "严格跨工作日恢复",
          `${person.name}：严格跨工作日恢复（禁止模式）；${records.map((r) => `${r.date} ${r.flightNo}/${r.position} ${r.startTime}–${r.endTime}`).join("、")}，本次不能接${task.flight.flightNo}/${task.rule.name}`
        );
        continue;
      }
      const reservations =
        facts?.crossFlightPriorityReservations.filter(
          (r) =>
            r.taskKey === task.key &&
            r.staffId === person.id &&
            selected.has(`${r.protectedTaskKey}:${r.alternativeStaffId}`)
        ) ?? [];
      const occupiedPriority = assignments.filter(
        (a) =>
          a.status === "assigned" &&
          a.staffId === person.id &&
          reservations.some((r) => r.priorityFlightNo === a.flightNo)
      );
      if (reservations.length) {
        add(
          "跨航班优先",
          `${person.name}：跨航班优先规则先保留给${[...new Set(reservations.map((r) => r.priorityFlightNo))].join("、")}；${occupiedPriority.map((a) => `当前承担${a.flightNo}/${a.position} ${a.startTime}–${a.endTime}`).join("、") || "当前优先航班由其他候选承担，模型仍限制该人员转入此岗"}`
        );
        continue;
      }
      // A reserved person can occupy the priority task themselves. The model
      // has no active alternative pair in that solution: report the actual
      // direct-insertion check, not an invented priority rejection.
      const diagnostic = evaluateAutomaticHardConstraints({
        state,
        assignments: assignments.filter((a) => a.id !== assignment.id),
        flight: task.flight,
        rule: task.rule,
        person,
        transitionMode: "forbid",
        ignoreSameFlightReusable: true,
        workHours: assignment.workHours,
      });
      if (diagnostic.violations.length) {
        const labels: Record<string, string> = {
          "staff-unavailable": "人员状态",
          "staff-type": "人员类型",
          "position-qualification": "岗位资质",
          "night-shift": "夜班能力",
          "time-conflict": "当前时段冲突",
          "daily-hours": "每日工时上限",
          "minimum-flight-transition": "航班最小衔接",
          "position-transition": "严格岗位衔接",
          "daily-primary-position-unique": "每日一号唯一",
          "same-flight-staff-exclusion": "同航班人员互斥",
        };
        add(
          labels[diagnostic.violations[0]!.code] ?? "其他限制",
          [...new Set(diagnostic.violations.map((v) => v.message))].join("；")
        );
      } else {
        add(
          "未记录的组合限制",
          `${person.name}：当前直接检查可通过，但本次未采用；完整换人方案的具体原因未记录`
        );
      }
    }
    const recoveryNotes = (assignment.systemNotes ?? []).filter(
      (note) =>
        note.includes("这个岗位已留空，其他合法安排保留") ||
        note.startsWith("这一轮督导换人未采用：")
    );
    const previousNotes = assignment.systemNotes ?? [];
    const searchNotes = isMobileSupervisor(task.flight, task.rule)
      ? previousNotes[0]?.startsWith("空岗：")
        ? previousNotes.filter((note) => note.startsWith("此前换人检查："))
        : previousNotes.map((note) => `此前换人检查：${note}`)
      : [];
    const stageEvidence = assignment.vacancyEvidence;
    const stageNotes = stageEvidence
      ? [
          `求解阶段记录：${stageEvidence.reason === "daily-flight-count-balance" ? DAILY_FLIGHT_COUNT_BALANCE_VACANCY_NOTE : NO_QUALIFIED_CANDIDATE_VACANCY_NOTE}；${stageEvidence.blockers.join("；")}`,
        ]
      : [];
    assignment.systemNotes = [
      people.length
        ? `空岗：${[...groups].map(([rule, entries]) => `${rule} ${entries.length} 人`).join("；")}`
        : "空岗：岗位资质名单无当前人员（0人）",
      ...[...groups.values()].flat(),
      ...stageNotes,
      ...recoveryNotes,
      ...searchNotes,
      "以上为本次候选限制与当前直接检查；不代表多岗换人一定无解。",
    ];
  }
}

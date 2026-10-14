import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  assignmentRule,
  isGapFillGuidePosition,
} from "../flights/schedule-position-rules";
import { getDutyRosterForDate } from "../duty-roster/roster";
import { latePriorityFrequencyKinds } from "../reviews/late-priority-policy";
import { createScheduleRunFacts } from "../shared/schedule-run-facts";
import { intervalsOverlap, durationHours, timeToMinutes } from "../shared/time";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import type { CrossWorkdayReservationDisposition } from "../solver/reassignment-intent";
import type { SolverPort } from "../solver/solver-port";
import { reassignmentSafetyReasons } from "../reviews/rotation-review-safety";
import { clearAutomaticAssignmentEvidence } from "../assignments/assignment-evidence";
import { diagnoseBaseAssignmentEligibility } from "../candidates/assignment-eligibility";
import {
  isLateEndingWork,
  isNextWorkdayCutoffConflict,
} from "../reviews/cross-day-recovery";
import {
  hasHighLoadTransition,
  lateShiftRecoveryRisk,
  rollingLoadCost,
} from "../reviews/schedule-protection";
import {
  comparePreviousWorkdayLoad,
  previousWorkdayLoadForStaff,
  type PreviousWorkdayLoad,
} from "../shared/previous-workday-load";
import {
  assignmentConsumesCrossWorkdayReservation,
  crossWorkdayReservationStatuses,
} from "../reviews/cross-workday-qualification-reservation";
import {
  isTeamLeaderGapFillVacancy,
  teamLeaderGapFillAssignmentProtectionReasons,
} from "./team-leader-gap-fill-protection";

export interface TeamLeaderGapFillChange {
  assignmentId: string;
  flightNo: string;
  position: string;
  fromStaffId: string | null;
  fromStaffName: string;
  toStaffId: string;
  toStaffName: string;
  workHours: number;
}

export interface TeamLeaderGapFillPreview {
  date: string;
  teamLeaderId: string;
  vacancyAssignmentIds: string[];
  baselineFingerprint: string;
  changes: TeamLeaderGapFillChange[];
  warnings: string[];
  rejectedCandidates: string[];
}

export type TeamLeaderGapFillPlanResult =
  | { kind: "ready"; preview: TeamLeaderGapFillPreview }
  | { kind: "unavailable"; reasons: string[] };

export type TeamLeaderGapFillApplyResult =
  | { kind: "applied"; assignments: Assignment[] }
  | { kind: "rejected"; reasons: string[] };

export interface PlanTeamLeaderGapFillOptions {
  solver: SolverPort;
  state: ScheduleGenerationFacts & { activeScheduleDate?: string | null };
  date: string;
  teamLeaderId: string;
  vacancyAssignmentIds: readonly string[];
}

export const TEAM_LEADER_GAP_FILL_MAX_CHANGED_ASSIGNMENTS = 15;

export function teamLeaderGapFillFingerprint(
  assignments: readonly Assignment[]
): string {
  return JSON.stringify(
    [...assignments]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((assignment) => [
        assignment.id,
        assignment.staffId,
        assignment.status,
        assignment.startTime,
        assignment.endTime,
        assignment.workHours,
        assignment.positionRuleId,
        assignment.remark,
        assignment.manualRemark,
        assignment.manualOverrideWarnings ?? null,
        assignment.supervisorSourceAssignmentId ?? null,
        assignment.teamLeaderGapFill ?? false,
      ])
  );
}

function isNearVacancy(
  assignment: Assignment,
  vacancies: readonly Assignment[]
): boolean {
  return vacancies.some(
    (vacancy) =>
      assignment.flightId === vacancy.flightId ||
      intervalsOverlap(
        assignment.startTime,
        assignment.endTime,
        vacancy.startTime,
        vacancy.endTime
      )
  );
}

function canStaffTakeVacancy(
  state: ScheduleGenerationFacts,
  vacancy: Assignment,
  staffId: string
): boolean {
  const person = state.staff.find((item) => item.id === staffId);
  const flight = state.flights.find((item) => item.id === vacancy.flightId);
  const rule = assignmentRule(state, vacancy);
  return Boolean(
    person &&
    flight &&
    rule &&
    diagnoseBaseAssignmentEligibility(state, flight, rule, person).eligible
  );
}

function canStaffTakeAssignment(
  state: ScheduleGenerationFacts,
  assignment: Assignment,
  staffId: string,
  allowDirectGuide = false
): boolean {
  const person = state.staff.find((item) => item.id === staffId);
  const flight = state.flights.find((item) => item.id === assignment.flightId);
  const rule = assignmentRule(state, assignment);
  return Boolean(
    person &&
    flight &&
    rule &&
    (diagnoseBaseAssignmentEligibility(state, flight, rule, person).eligible ||
      (allowDirectGuide &&
        isGapFillGuidePosition(rule) &&
        person.teamLeader === true))
  );
}

function unavailable(...reasons: string[]): TeamLeaderGapFillPlanResult {
  return { kind: "unavailable", reasons: [...new Set(reasons)] };
}

function formatAssignment(assignment: Assignment): string {
  return `${assignment.flightNo}/${assignment.position}（${assignment.startTime}-${assignment.endTime}）`;
}

function actualProtectionReasons(
  state: ScheduleGenerationFacts,
  assignment: Assignment,
  dutyStaffId: string | null
): string[] {
  return teamLeaderGapFillAssignmentProtectionReasons(
    state,
    assignment,
    dutyStaffId
  ).filter(
    (reason) => reason !== "不是有效已排岗位" && reason !== "岗位规则不存在"
  );
}

function formatCandidateRejections(
  rejections: NonNullable<
    Awaited<ReturnType<typeof optimizeReassignment>>["candidateRejections"]
  >,
  priorityStaffIds?: ReadonlySet<string>
): string[] {
  const prioritized = priorityStaffIds
    ? [
        ...rejections.filter((rejection) =>
          priorityStaffIds.has(rejection.staffId)
        ),
        ...rejections.filter(
          (rejection) => !priorityStaffIds.has(rejection.staffId)
        ),
      ]
    : rejections;
  return prioritized.slice(0, 12).map((rejection) => {
    const target = rejection.flightNo
      ? `${rejection.flightNo}/${rejection.position}（${rejection.startTime}-${rejection.endTime}）`
      : "目标岗位";
    const reason = rejection.reasons[0] ?? "不满足安全条件";
    const humanReason = reason.startsWith("这个时段已经安排了其他岗位：")
      ? `硬拒绝：与${reason.slice("这个时段已经安排了其他岗位：".length)}时间冲突`
      : `硬拒绝：${reason}`;
    const secondary =
      priorityStaffIds && !priorityStaffIds.has(rejection.staffId)
        ? "其他尝试："
        : "";
    return `${secondary}${rejection.staffName}尝试接${target}失败：${humanReason}`;
  });
}

function previousLoadText(load: PreviousWorkdayLoad): string {
  const latestEnd = load.latestEndMinutes
    ? `${String(Math.floor(load.latestEndMinutes / 60) % 24).padStart(2, "0")}:${String(load.latestEndMinutes % 60).padStart(2, "0")}`
    : "无";
  return `疲劳${load.fatiguePoints}点、最晚结束${latestEnd}、工时${load.workHours}小时、末班重点${load.priorityPositionCount}个`;
}

interface CurrentLateBurden {
  latestEndMinutes: number;
  fatiguePoints: number;
  priorityPositionCount: number;
}

function currentLateBurden(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  staffId: string
): CurrentLateBurden {
  const relevant = assignments.filter(
    (assignment) =>
      assignment.staffId === staffId &&
      assignment.status === "assigned" &&
      isLateEndingWork(assignment, state)
  );
  return relevant.reduce<CurrentLateBurden>(
    (burden, assignment) => {
      const end = timeToMinutes(assignment.endTime);
      const rule = assignmentRule(state, assignment);
      return {
        latestEndMinutes: Number.isFinite(end)
          ? Math.max(burden.latestEndMinutes, end)
          : burden.latestEndMinutes,
        fatiguePoints: burden.fatiguePoints + assignment.fatiguePoints,
        priorityPositionCount:
          burden.priorityPositionCount +
          (rule && latePriorityFrequencyKinds(rule).length > 0 ? 1 : 0),
      };
    },
    { latestEndMinutes: 0, fatiguePoints: 0, priorityPositionCount: 0 }
  );
}

function compareCurrentLateBurden(
  left: CurrentLateBurden,
  right: CurrentLateBurden
): number {
  return (
    left.latestEndMinutes - right.latestEndMinutes ||
    left.fatiguePoints - right.fatiguePoints ||
    left.priorityPositionCount - right.priorityPositionCount
  );
}

function plannedAssignmentsForChanges(
  state: ScheduleGenerationFacts,
  changes: readonly {
    assignmentId: string;
    staffId: string;
    workHours?: number;
    status?: Assignment["status"];
  }[]
): Assignment[] {
  const staffById = new Map(state.staff.map((person) => [person.id, person]));
  const changeById = new Map(
    changes.map((change) => [change.assignmentId, change])
  );
  return state.assignments.map((assignment) => {
    const change = changeById.get(assignment.id);
    if (!change) return { ...assignment };
    const person = staffById.get(change.staffId);
    return {
      ...assignment,
      staffId: change.staffId,
      staffName: person?.name ?? assignment.staffName,
      workHours: change.workHours ?? assignment.workHours,
      status: change.status ?? "assigned",
    };
  });
}

function crossWorkdayReservationWarnings(
  state: ScheduleGenerationFacts,
  changes: readonly {
    assignmentId: string;
    staffId: string;
    workHours?: number;
    status?: Assignment["status"];
  }[]
): string[] {
  const before = crossWorkdayReservationStatuses(state, state.assignments);
  const planned = plannedAssignmentsForChanges(state, changes);
  const after = crossWorkdayReservationStatuses(state, planned);
  const personById = new Map(state.staff.map((person) => [person.id, person]));
  const cutoffLabel = state.settings.lateShiftEndTime;
  const warnings: string[] = [];
  after.forEach((afterStatus, index) => {
    const beforeStatus = before[index];
    if (!beforeStatus || afterStatus.shortfall <= beforeStatus.shortfall)
      return;
    const reservation = afterStatus.target.reservation;
    const qualifiedNames = [...afterStatus.target.qualifiedStaffIds].map(
      (staffId) => personById.get(staffId)?.name ?? staffId
    );
    const consumed = new Map<string, string>();
    planned
      .filter(
        (assignment) =>
          assignment.staffId &&
          afterStatus.target.qualifiedStaffIds.has(assignment.staffId) &&
          assignmentConsumesCrossWorkdayReservation(state, assignment)
      )
      .forEach((assignment) => {
        if (!consumed.has(assignment.staffId!))
          consumed.set(
            assignment.staffId!,
            `${personById.get(assignment.staffId!)?.name ?? assignment.staffId}（${formatAssignment(assignment)}）`
          );
      });
    warnings.push(
      `黄灯：下一工作班${reservation.flightNo}/${reservation.keyword}要求至少保留${reservation.minimumStaffCount}名合格人员；合格人员：${qualifiedNames.join("、") || "无"}；${
        [...consumed.values()].join("、") || "无人"
      }因${cutoffLabel}后岗位被消耗；预留人数从${beforeStatus.preservedStaffIds.length}变为${afterStatus.preservedStaffIds.length}。`
    );
  });
  return warnings;
}

function relativeFatigueWarnings(
  state: ScheduleGenerationFacts,
  facts: ReturnType<typeof createScheduleRunFacts>,
  changes: readonly {
    assignmentId: string;
    staffId: string;
    workHours?: number;
    status?: Assignment["status"];
  }[],
  relevantAssignmentIds: ReadonlySet<string>
): string[] {
  const planned = plannedAssignmentsForChanges(state, changes);
  const involvedStaffIds = new Set(
    planned
      .filter(
        (assignment) =>
          relevantAssignmentIds.has(assignment.id) &&
          Boolean(assignment.staffId) &&
          isLateEndingWork(assignment, state)
      )
      .map((assignment) => assignment.staffId!)
  );
  const staffById = new Map(state.staff.map((person) => [person.id, person]));
  const loads = new Map(
    [...involvedStaffIds].map((staffId) => [
      staffId,
      previousWorkdayLoadForStaff(facts.previousWorkdayLoad, staffId),
    ])
  );
  const burdens = new Map(
    [...involvedStaffIds].map((staffId) => [
      staffId,
      currentLateBurden(state, planned, staffId),
    ])
  );
  const warnings: string[] = [];
  const ids = [...involvedStaffIds];
  for (const leftId of ids) {
    for (const rightId of ids) {
      if (leftId === rightId) continue;
      const leftLoad = loads.get(leftId)!;
      const rightLoad = loads.get(rightId)!;
      if (comparePreviousWorkdayLoad(leftLoad, rightLoad) <= 0) continue;
      if (
        compareCurrentLateBurden(burdens.get(leftId)!, burdens.get(rightId)!) <=
        0
      )
        continue;
      const left = staffById.get(leftId);
      const right = staffById.get(rightId);
      if (!left || !right) continue;
      warnings.push(
        `${left.name}上一工作班更需要休息（${previousLoadText(leftLoad)}），但本次末班段负担比${right.name}更重；${left.name}当前末班负担为${burdens.get(leftId)!.latestEndMinutes ? `${String(Math.floor(burdens.get(leftId)!.latestEndMinutes / 60) % 24).padStart(2, "0")}:${String(burdens.get(leftId)!.latestEndMinutes % 60).padStart(2, "0")}` : "无晚班"}、疲劳${burdens.get(leftId)!.fatiguePoints}点，${right.name}为${burdens.get(rightId)!.latestEndMinutes ? `${String(Math.floor(burdens.get(rightId)!.latestEndMinutes / 60) % 24).padStart(2, "0")}:${String(burdens.get(rightId)!.latestEndMinutes % 60).padStart(2, "0")}` : "无晚班"}、疲劳${burdens.get(rightId)!.fatiguePoints}点。`
      );
    }
  }
  return [...new Set(warnings)];
}

function recoveryWarnings(
  state: ScheduleGenerationFacts,
  facts: ReturnType<typeof createScheduleRunFacts>,
  date: string,
  changes: readonly {
    assignmentId: string;
    staffId: string;
    workHours?: number;
    status?: Assignment["status"];
  }[]
): string[] {
  const planned = plannedAssignmentsForChanges(state, changes);
  const warnings: string[] = [];
  for (const assignment of planned) {
    if (!changes.some((change) => change.assignmentId === assignment.id))
      continue;
    if (!assignment.staffId) continue;
    const records =
      facts.crossDayRecovery.previousWorkday.protectedRecords.filter(
        (record) => record.staffId === assignment.staffId
      );
    if (!records.length) continue;
    const cutoffConflict = isNextWorkdayCutoffConflict(
      state,
      assignment.staffId,
      assignment.startTime,
      date,
      facts.crossDayRecovery
    );
    const recoveryRisk =
      lateShiftRecoveryRisk(
        state,
        assignment.staffId,
        assignment,
        date,
        facts.crossDayRecovery
      ).excess > 0;
    if (!cutoffConflict && !recoveryRisk) continue;
    const record = records[0]!;
    const person = state.staff.find((item) => item.id === assignment.staffId);
    warnings.push(
      `${person?.name ?? assignment.staffId}上一工作班承担${record.flightNo}/${record.position}（${record.startTime}-${record.endTime}，${record.remark || "末班重点"}），本次补差安排到${formatAssignment(assignment)}；跨工作日恢复本应尽量避开，本方案为补空缺让步。`
    );
  }
  return [...new Set(warnings)];
}

function loadProtectionWarnings(
  state: ScheduleGenerationFacts,
  changes: readonly {
    assignmentId: string;
    staffId: string;
    workHours?: number;
    status?: Assignment["status"];
  }[]
): string[] {
  const planned = plannedAssignmentsForChanges(state, changes);
  const changedIds = new Set(changes.map((change) => change.assignmentId));
  const staffById = new Map(state.staff.map((person) => [person.id, person]));
  const warnings: string[] = [];
  for (const assignment of planned) {
    if (!changedIds.has(assignment.id) || !assignment.staffId) continue;
    const personName =
      staffById.get(assignment.staffId)?.name ?? assignment.staffId;
    const highLoadPeer = planned.find(
      (other) =>
        other.id !== assignment.id &&
        other.staffId === assignment.staffId &&
        hasHighLoadTransition(
          [other],
          assignment.staffId!,
          assignment.startTime,
          assignment.endTime,
          assignment.fatiguePoints,
          assignment.remark,
          state
        )
    );
    if (highLoadPeer) {
      warnings.push(
        `${personName}补差后承担${formatAssignment(assignment)}，与${formatAssignment(highLoadPeer)}均为高负荷岗位，间隔不超过${state.settings.highLoadRecoveryMinutes}分钟，触发高负荷疲劳保护；本方案为补空缺黄灯让步。`
      );
    }
    if (
      rollingLoadCost(
        planned,
        assignment.staffId,
        assignment.startTime,
        assignment.fatiguePoints,
        assignment.remark,
        state
      ) > 0
    ) {
      warnings.push(
        `${personName}补差后承担${formatAssignment(assignment)}，其开始前${state.settings.rollingLoadWindowMinutes}分钟内累计疲劳将超过${state.settings.rollingLoadMaxFatigue}点，触发滚动负荷保护；本方案为补空缺黄灯让步。`
      );
    }
  }
  return [...new Set(warnings)];
}

export async function planTeamLeaderGapFill({
  solver,
  state,
  date,
  teamLeaderId,
  vacancyAssignmentIds,
}: PlanTeamLeaderGapFillOptions): Promise<TeamLeaderGapFillPlanResult> {
  if (state.activeScheduleDate && state.activeScheduleDate !== date)
    return unavailable("当前日期没有可补差的班表");
  const leader = state.staff.find((person) => person.id === teamLeaderId);
  if (
    !leader?.teamLeader ||
    leader.status !== "正常" ||
    leader.staffType !== "常规"
  )
    return unavailable("请选择状态正常的分队长");

  const selectedIds = [...new Set(vacancyAssignmentIds)];
  if (!selectedIds.length) return unavailable("请至少选择一个空缺");
  const selectedIdSet = new Set(selectedIds);
  const vacancies = selectedIds.flatMap((assignmentId) => {
    const assignment = state.assignments.find(
      (item) => item.id === assignmentId
    );
    return assignment && isTeamLeaderGapFillVacancy(state, assignment)
      ? [assignment]
      : [];
  });
  if (vacancies.length !== selectedIds.length)
    return unavailable(
      "所选岗位已不是可补差的自动常规或机动督导空缺，请刷新后重选"
    );

  const dutyStaffId = getDutyRosterForDate(state, date).dutyStaffId;
  const vacancyCandidateStaffIds = new Set(
    state.staff
      .filter((person) =>
        vacancies.some((vacancy) =>
          canStaffTakeVacancy(state, vacancy, person.id)
        )
      )
      .map((person) => person.id)
  );
  const isPotentialChainSource = (assignment: Assignment): boolean =>
    Boolean(
      assignment.staffId &&
      vacancyCandidateStaffIds.has(assignment.staffId) &&
      canStaffTakeAssignment(state, assignment, leader.id, true)
    );
  const protectedChainExists = state.assignments.some(
    (assignment) =>
      !selectedIdSet.has(assignment.id) &&
      (isNearVacancy(assignment, vacancies) ||
        isPotentialChainSource(assignment)) &&
      actualProtectionReasons(state, assignment, dutyStaffId).length > 0
  );
  const movableAssigned = state.assignments.filter(
    (assignment) =>
      !selectedIdSet.has(assignment.id) &&
      assignment.staffId !== null &&
      (isNearVacancy(assignment, vacancies) ||
        (vacancyCandidateStaffIds.has(assignment.staffId) &&
          canStaffTakeAssignment(state, assignment, leader.id, true))) &&
      actualProtectionReasons(state, assignment, dutyStaffId).length === 0
  );
  const movable = [...vacancies, ...movableAssigned];
  const participatingStaffIds = new Set([
    leader.id,
    ...movableAssigned.flatMap((assignment) =>
      assignment.staffId ? [assignment.staffId] : []
    ),
  ]);
  const workHoursByAssignmentId = new Map(
    movable.map((assignment) => [
      assignment.id,
      assignment.status === "unfilled"
        ? durationHours(assignment.startTime, assignment.endTime)
        : assignment.workHours,
    ])
  );
  const facts = createScheduleRunFacts(state, date);
  const optimizeGapFill = (
    enforceRelativeFatigue: boolean,
    crossWorkdayReservation: CrossWorkdayReservationDisposition
  ) =>
    optimizeReassignment({
      solver,
      state,
      assignments: state.assignments,
      primary: vacancies[0]!,
      movableAssignments: movable.slice(1),
      date,
      facts,
      frequencyFacts: facts.scheduleFrequency,
      intent: {
        kind: "team-leader-gap-fill",
        crossWorkdayReservation,
      },
      collectAllCandidateRejections: true,
      candidateAllowed: (assignment, person) =>
        selectedIdSet.has(assignment.id)
          ? vacancyCandidateStaffIds.has(person.id)
          : participatingStaffIds.has(person.id),
      primaryCandidateAllowed: () => true,
      choiceWorkHours: (assignment) =>
        workHoursByAssignmentId.get(assignment.id) ?? assignment.workHours,
      normalizeChanges: (changes) =>
        changes.map((change) => ({
          ...change,
          workHours:
            workHoursByAssignmentId.get(change.assignmentId) ??
            change.workHours,
          status: "assigned",
        })),
      requiredStaffIds: [leader.id],
      timeoutMs: 4_000,
      validateChanges: (changes) => {
        const changedIds = new Set(
          changes.map((change) => change.assignmentId)
        );
        const reasons: string[] = [];
        if (selectedIds.some((assignmentId) => !changedIds.has(assignmentId)))
          reasons.push("所选空缺没有全部补齐");
        if (
          changes.some(
            (change) => !movable.some((item) => item.id === change.assignmentId)
          )
        )
          reasons.push("方案超出所选空缺的局部范围");
        if (enforceRelativeFatigue)
          reasons.push(
            ...relativeFatigueWarnings(
              state,
              facts,
              changes,
              new Set(movable.map((assignment) => assignment.id))
            ).map((reason) => `相对疲劳偏好：${reason}`)
          );
        return reasons;
      },
    });

  const findGapFillPlan = async (
    crossWorkdayReservation: CrossWorkdayReservationDisposition
  ) => {
    let result = await optimizeGapFill(true, crossWorkdayReservation);
    const preferredPlanUnavailable =
      !result.changes &&
      result.attemptedReasons.some((reason) =>
        reason.startsWith("相对疲劳偏好：")
      );
    if (preferredPlanUnavailable)
      result = await optimizeGapFill(false, crossWorkdayReservation);
    return { result, preferredPlanUnavailable };
  };

  let planAttempt = await findGapFillPlan("preserve");
  const strictAttemptedReasons = [...planAttempt.result.attemptedReasons];
  const strictCandidateRejections = [
    ...(planAttempt.result.candidateRejections ?? []),
  ];
  let reservationPlanUnavailable = false;
  if (
    !planAttempt.result.changes &&
    planAttempt.result.attemptedReasons.some(
      (reason) => reason === "调整会减少跨工作日资质预留人数"
    )
  ) {
    reservationPlanUnavailable = true;
    planAttempt = await findGapFillPlan("yield-to-selected-vacancy");
  }
  const { result, preferredPlanUnavailable } = planAttempt;
  const attemptedReasons = [
    ...new Set([...strictAttemptedReasons, ...result.attemptedReasons]),
  ];
  const candidateRejections = [
    ...strictCandidateRejections,
    ...(result.candidateRejections ?? []),
  ];
  const candidateReasonTexts = new Set(
    candidateRejections.flatMap((rejection) => rejection.reasons)
  );
  if (!result.changes)
    return unavailable(
      ...attemptedReasons.filter(
        (reason) =>
          !candidateReasonTexts.has(reason) &&
          reason !== "没有具备双向岗位资质的完整重排方案" &&
          !reason.startsWith("相对疲劳偏好：") &&
          !reason.includes("求解目标") &&
          !reason.includes("infeasible") &&
          !reason.includes("整体重排达到时间上限")
      ),
      ...formatCandidateRejections(candidateRejections, participatingStaffIds),
      ...(protectedChainExists
        ? [
            `附近另有保护岗（未证明本方案需要移动它们）：${state.assignments
              .filter(
                (assignment) =>
                  !selectedIdSet.has(assignment.id) &&
                  (isNearVacancy(assignment, vacancies) ||
                    isPotentialChainSource(assignment)) &&
                  actualProtectionReasons(state, assignment, dutyStaffId)
                    .length > 0
              )
              .slice(0, 8)
              .map(
                (assignment) =>
                  `${assignment.staffName || assignment.staffId}的${formatAssignment(assignment)}（${actualProtectionReasons(state, assignment, dutyStaffId).join("、")}）`
              )
              .join("；")}`,
          ]
        : []),
      ...(attemptedReasons.some((reason) =>
        reason.includes("没有具备双向岗位资质")
      ) || !result.attemptedReasons.length
        ? ["找不到安全换人链"]
        : [])
    );

  const assignmentById = new Map(
    state.assignments.map((assignment) => [assignment.id, assignment])
  );
  const personById = new Map(state.staff.map((person) => [person.id, person]));
  const changes = result.changes.map((change) => {
    const assignment = assignmentById.get(change.assignmentId)!;
    const person = personById.get(change.staffId)!;
    return {
      assignmentId: assignment.id,
      flightNo: assignment.flightNo,
      position: assignment.position,
      fromStaffId: assignment.staffId,
      fromStaffName: assignment.staffName,
      toStaffId: person.id,
      toStaffName: person.name,
      workHours:
        workHoursByAssignmentId.get(assignment.id) ?? assignment.workHours,
    };
  });
  const warnings = [
    ...recoveryWarnings(state, facts, date, result.changes),
    ...loadProtectionWarnings(state, result.changes),
    ...(reservationPlanUnavailable
      ? crossWorkdayReservationWarnings(state, result.changes)
      : []),
    ...(new Set(result.changes.map((change) => change.assignmentId)).size >
    TEAM_LEADER_GAP_FILL_MAX_CHANGED_ASSIGNMENTS
      ? [
          `黄灯：本方案实际改变${new Set(result.changes.map((change) => change.assignmentId)).size}个岗位，超过建议上限${TEAM_LEADER_GAP_FILL_MAX_CHANGED_ASSIGNMENTS}个岗位；其余硬约束已通过，请确认是否继续。`,
        ]
      : []),
    ...(preferredPlanUnavailable
      ? relativeFatigueWarnings(
          state,
          facts,
          result.changes,
          new Set(movable.map((assignment) => assignment.id))
        ).map(
          (warning) =>
            `${warning} 在不突破资质、时间冲突、保护岗、岗位完整性的前提下，未找到可继续调整的更轻方案，本方案黄灯放行。`
        )
      : []),
  ];
  return {
    kind: "ready",
    preview: {
      date,
      teamLeaderId: leader.id,
      vacancyAssignmentIds: selectedIds,
      baselineFingerprint: teamLeaderGapFillFingerprint(state.assignments),
      changes,
      warnings: [...new Set(warnings)],
      rejectedCandidates: formatCandidateRejections(
        result.candidateRejections ?? [],
        participatingStaffIds
      ),
    },
  };
}

export function applyTeamLeaderGapFillPreview(
  state: ScheduleGenerationFacts & { activeScheduleDate?: string | null },
  preview: TeamLeaderGapFillPreview
): TeamLeaderGapFillApplyResult {
  if (
    state.activeScheduleDate !== preview.date ||
    teamLeaderGapFillFingerprint(state.assignments) !==
      preview.baselineFingerprint
  )
    return {
      kind: "rejected",
      reasons: ["班表已变化，请重新生成补差预览"],
    };
  const leader = state.staff.find(
    (person) =>
      person.id === preview.teamLeaderId &&
      person.teamLeader &&
      person.status === "正常" &&
      person.staffType === "常规"
  );
  if (!leader) return { kind: "rejected", reasons: ["所选分队长已不可用"] };

  const vacancyIds = new Set(preview.vacancyAssignmentIds);
  const vacancies = state.assignments.filter((assignment) =>
    vacancyIds.has(assignment.id)
  );
  if (
    vacancies.length !== vacancyIds.size ||
    vacancies.some(
      (assignment) => assignment.status !== "unfilled" || assignment.staffId
    )
  )
    return { kind: "rejected", reasons: ["所选空缺已变化，请重新预览"] };
  if (
    vacancies.some(
      (assignment) => !isTeamLeaderGapFillVacancy(state, assignment)
    )
  )
    return { kind: "rejected", reasons: ["所选空缺已不再符合补差范围"] };
  const changesByAssignmentId = new Map(
    preview.changes.map((change) => [change.assignmentId, change])
  );
  if (
    changesByAssignmentId.size !== preview.changes.length ||
    [...vacancyIds].some(
      (assignmentId) => !changesByAssignmentId.has(assignmentId)
    ) ||
    !preview.changes.some((change) => change.toStaffId === leader.id)
  )
    return { kind: "rejected", reasons: ["补差预览不完整"] };

  const dutyStaffId = getDutyRosterForDate(state, preview.date).dutyStaffId;
  const vacancyCandidateStaffIds = new Set(
    vacancies.flatMap((vacancy) =>
      state.staff
        .filter((person) => canStaffTakeVacancy(state, vacancy, person.id))
        .map((person) => person.id)
    )
  );
  const changes = preview.changes.flatMap((change) => {
    const assignment = state.assignments.find(
      (item) => item.id === change.assignmentId
    );
    const person = state.staff.find((item) => item.id === change.toStaffId);
    if (!assignment || !person) return [];
    const selectedVacancy = vacancyIds.has(assignment.id);
    if (
      (!selectedVacancy &&
        (teamLeaderGapFillAssignmentProtectionReasons(
          state,
          assignment,
          dutyStaffId
        ).length > 0 ||
          !(
            isNearVacancy(assignment, vacancies) ||
            (Boolean(assignment.staffId) &&
              vacancyCandidateStaffIds.has(assignment.staffId!) &&
              canStaffTakeAssignment(state, assignment, leader.id, true))
          ))) ||
      assignment.staffId !== change.fromStaffId ||
      assignment.staffName !== change.fromStaffName
    )
      return [];
    return [
      {
        assignmentId: assignment.id,
        staffId: person.id,
        workHours: selectedVacancy
          ? durationHours(assignment.startTime, assignment.endTime)
          : assignment.workHours,
        status: "assigned" as const,
      },
    ];
  });
  if (changes.length !== preview.changes.length)
    return {
      kind: "rejected",
      reasons: ["补差方案已超出允许的局部范围"],
    };

  const facts = createScheduleRunFacts(state, preview.date);
  const safetyReasons = reassignmentSafetyReasons({
    kind: "plan",
    state,
    assignments: state.assignments,
    changes,
    primaryAssignmentId: preview.vacancyAssignmentIds[0]!,
    date: preview.date,
    facts,
    frequencyFacts: facts.scheduleFrequency,
    intent: {
      kind: "team-leader-gap-fill",
      crossWorkdayReservation: "yield-to-selected-vacancy",
    },
  });
  if (safetyReasons.length) return { kind: "rejected", reasons: safetyReasons };

  const personById = new Map(state.staff.map((person) => [person.id, person]));
  const planned = state.assignments.map((assignment) => {
    const change = changesByAssignmentId.get(assignment.id);
    if (!change) return { ...assignment };
    const person = personById.get(change.toStaffId)!;
    const next = { ...assignment };
    next.staffId = person.id;
    next.staffName = person.name;
    next.status = "assigned";
    next.workHours = vacancyIds.has(next.id)
      ? durationHours(next.startTime, next.endTime)
      : next.workHours;
    clearAutomaticAssignmentEvidence(next);
    delete next.manualOverrideWarnings;
    if (person.id === leader.id) next.teamLeaderGapFill = true;
    else delete next.teamLeaderGapFill;
    return next;
  });
  if (
    planned.some(
      (assignment) =>
        vacancyIds.has(assignment.id) &&
        (assignment.status !== "assigned" || !assignment.staffId)
    )
  )
    return { kind: "rejected", reasons: ["所选空缺没有全部补齐"] };
  return { kind: "applied", assignments: planned };
}

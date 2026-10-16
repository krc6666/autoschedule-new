import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { RuleFeedbackKey } from "../rules/schedule-rule-contract";
import { diagnoseAutomaticAssignmentEligibility } from "../candidates/assignment-eligibility";
import { conciseAssignmentWarningReason } from "../reviews/schedule-warning-message";
import { groupStaffFlightsByNormalizedNumber } from "../statistics/staff-flight-count";
import type { ScheduleFeedbackOptions } from "./schedule-feedback";
import { compileSchedulingPlan } from "../rules/scheduling-execution-plan";
import { recentArchivedWorkdays } from "../statistics/fatigue";
import {
  getDutyRosterForDate,
  getMonthlyDutyRoster,
  getMonthlyDutyRosterStats,
} from "../duty-roster/roster";
import {
  configuredDutyPositionPriority,
  dutyLatePositionPriority,
  isDutyMorningFlight,
} from "../assignments/duty-assignment";
import {
  isLateEndingWork,
  isNextWorkdayCutoffConflict,
  matchesLateShiftRecoveryPosition,
  matchesNextWorkdayRecoveryTarget,
  previousWorkdayLateProtection,
} from "../reviews/cross-day-recovery";
import { isHighLoadPosition } from "../reviews/schedule-protection";
import {
  crossWorkdayReservationStatuses,
  crossWorkdayReservationWarning,
} from "../reviews/cross-workday-qualification-reservation";
import { isPreNoonFlight } from "../flights/schedule-tasks";
import {
  countedWorkloadAssignments,
  isCountedWorkloadAssignment,
} from "../shared/workload-accounting";
import { PRIORITY_ROTATION_POSITION_KEYWORDS } from "../reviews/position-rotation-policy";
import {
  assignmentDecisionMessages,
  assignmentDecisions,
} from "../assignments/assignment-evidence";
import {
  DAILY_FLIGHT_COUNT_BALANCE_VACANCY_NOTE,
  NO_QUALIFIED_CANDIDATE_VACANCY_NOTE,
} from "../assignments/vacancy-evidence";
import {
  conciseNames,
  operationalStart,
  timedAssignments,
} from "./schedule-feedback-facts";
import {
  feedbackItem,
  type ScheduleFeedbackItem,
} from "./schedule-feedback-model";

function morningPriorityFeedback(
  state: ScheduleGenerationFacts
): ScheduleFeedbackItem {
  const assignments = state.assignments.filter((assignment) => {
    if (!isPreNoonFlight(assignment)) return false;
    const rule = assignment.positionRuleId
      ? state.positionRules.find(
          (item) => item.id === assignment.positionRuleId
        )
      : undefined;
    return rule?.category === "常规";
  });
  if (!assignments.length) {
    return feedbackItem(
      "rule-execution",
      "morning-priority",
      "12点前岗位完整性",
      "info",
      "当天没有12点以前开始航班的常规岗位，无法形成执行基准。"
    );
  }
  const issues = assignments.flatMap((assignment) =>
    (assignment.systemNotes ?? []).map(
      (note) => `${assignment.flightNo}/${assignment.position}：${note}`
    )
  );
  if (issues.length) {
    return feedbackItem(
      "rule-execution",
      "morning-priority",
      "12点前岗位完整性",
      "attention",
      `共 ${assignments.length} 个12点前常规岗位；${issues.join("；")}。`
    );
  }
  return feedbackItem(
    "rule-execution",
    "morning-priority",
    "12点前岗位完整性",
    "ok",
    `共 ${assignments.length} 个12点前常规岗位，已按单岗位可胜任人数从少到多安排且全部填满，未突破严格限制。`
  );
}

function highLoadFeedback(
  state: ScheduleGenerationFacts
): ScheduleFeedbackItem {
  const highLoadAssignments = timedAssignments(state)
    .filter((item) => isCountedWorkloadAssignment(state, item.assignment))
    .filter((item) =>
      isHighLoadPosition(
        item.assignment.fatiguePoints,
        item.assignment.remark,
        state
      )
    );
  if (!state.settings.highLoadProtectionEnabled) {
    return feedbackItem(
      "rule-execution",
      "high-load",
      "连续高负荷",
      "info",
      `高负荷衔接保护已停用；当前有 ${highLoadAssignments.length} 个高负荷岗位，无法判断该保护规则是否执行。`
    );
  }
  const staffIds = [
    ...new Set(highLoadAssignments.map((item) => item.assignment.staffId)),
  ];
  const repeated = staffIds.flatMap((staffId) => {
    const own = highLoadAssignments
      .filter((item) => item.assignment.staffId === staffId)
      .sort((left, right) => left.start - right.start);
    return own
      .slice(1)
      .filter(
        (item, index) =>
          item.start - own[index]!.end <= state.settings.highLoadRecoveryMinutes
      )
      .map((item) => item.assignment.staffName);
  });
  if (repeated.length) {
    return feedbackItem(
      "rule-execution",
      "high-load",
      "连续高负荷",
      "attention",
      `${conciseNames(repeated)}在 ${state.settings.highLoadRecoveryMinutes} 分钟恢复期内连续承担高负荷岗位；为保证岗位完整性，已超保护仍安排，请复核现场承受能力。`
    );
  }
  return feedbackItem(
    "rule-execution",
    "high-load",
    "连续高负荷",
    "ok",
    `${highLoadAssignments.length} 个高负荷岗位均未由同一人员在 ${state.settings.highLoadRecoveryMinutes} 分钟恢复期内连续承担。`
  );
}

function crossWorkdayQualificationReservationFeedback(
  state: ScheduleGenerationFacts
): ScheduleFeedbackItem {
  const statuses = crossWorkdayReservationStatuses(state);
  if (!statuses.length) {
    return feedbackItem(
      "rule-execution",
      "cross-workday-qualification-reservation",
      "跨工作日资质预留",
      "info",
      "尚未配置跨工作日资质预留目标。"
    );
  }
  const shortfalls = statuses.filter((status) => status.shortfall > 0);
  if (shortfalls.length) {
    return feedbackItem(
      "rule-execution",
      "cross-workday-qualification-reservation",
      "跨工作日资质预留",
      "attention",
      shortfalls.map(crossWorkdayReservationWarning).join("；")
    );
  }
  return feedbackItem(
    "rule-execution",
    "cross-workday-qualification-reservation",
    "跨工作日资质预留",
    "ok",
    statuses
      .map(
        (status) =>
          `${status.target.reservation.flightNo}/${status.target.reservation.keyword}已保留 ${status.preservedStaffIds.length} 名合格人员`
      )
      .join("；")
  );
}

function previousLateFeedback(
  state: ScheduleGenerationFacts,
  date: string
): ScheduleFeedbackItem {
  const protection = previousWorkdayLateProtection(state, date);
  const { previousDate, protectedRecords, protectedStaffIds } = protection;
  if (!previousDate)
    return feedbackItem(
      "rule-execution",
      "previous-late",
      "上一工作日晚班人员跟踪",
      "info",
      "暂无最近工作日归档，无法核对跨工作日恢复保护。"
    );
  const protectedIds = [...protectedStaffIds];
  if (!protectedIds.length)
    return feedbackItem(
      "rule-execution",
      "previous-late",
      "上一工作日晚班人员跟踪",
      "ok",
      `${previousDate} 最后一批晚班没有命中已配置的末班重点岗位，无需跨工作日保护。`
    );
  const previousDetails = protectedIds
    .map((staffId) => {
      const own = protectedRecords.filter(
        (record) => record.staffId === staffId
      );
      const roles = [...new Set(own.map(compactFlightRole))].join("、");
      return `${own[0]?.staffName ?? staffId} ${roles}`;
    })
    .join("；");
  let needsReview = false;
  const currentDetails = protectedIds
    .map((staffId) => {
      const ownAssignments = countedWorkloadAssignments(state).filter(
        (assignment) =>
          assignment.staffId === staffId && assignment.status === "assigned"
      );
      const own = ownAssignments
        .filter((assignment) => assignment.workHours > 0)
        .sort(
          (left, right) =>
            operationalStart(left.startTime, state) -
            operationalStart(right.startTime, state)
        );
      const name =
        protectedRecords.find((record) => record.staffId === staffId)
          ?.staffName ?? staffId;
      if (!own.length) return `${name}今日未安排实际岗位，已休整`;
      const protectedMorningAssignments = ownAssignments.filter((assignment) =>
        matchesNextWorkdayRecoveryTarget(state, {
          flightNo: assignment.flightNo,
          position: assignment.position,
          remark: assignment.remark,
        })
      );
      const repeatedLatePriority = own.filter(
        (assignment) =>
          isLateEndingWork(assignment, state) &&
          matchesLateShiftRecoveryPosition(state, assignment)
      );
      const cutoffConflicts = own.filter((assignment) =>
        isNextWorkdayCutoffConflict(state, staffId, assignment.startTime, date)
      );
      needsReview ||=
        protectedMorningAssignments.length > 0 ||
        repeatedLatePriority.length > 0 ||
        cutoffConflicts.length > 0;
      const protectedAssignments = [
        ...new Map(
          [
            ...protectedMorningAssignments,
            ...repeatedLatePriority,
            ...cutoffConflicts,
          ].map((assignment) => [assignment.id, assignment])
        ).values(),
      ];
      const overrideReasons = assignmentDecisionMessages(protectedAssignments, {
        ruleIds: new Set(["late-shift-recovery", "late-shift-cutoff"]),
        outcomes: new Set(["fallback"]),
      });
      if (!protectedAssignments.length) return `${name} 已避开`;
      return `${name} 未落实（${[...new Set(protectedAssignments.map(compactFlightRole))].join("、")}；${conciseProtectionReason(overrideReasons)}）`;
    })
    .join("；");
  return feedbackItem(
    "rule-execution",
    "previous-late",
    "上一工作日晚班人员跟踪",
    needsReview ? "attention" : "ok",
    `${previousDate}：${previousDetails}。本班：${currentDetails}。`
  );
}

function flightCode(flightNo: string): string {
  return (
    /^[A-Z]+/i.exec(flightNo.trim())?.[0]?.toUpperCase() ?? flightNo.trim()
  );
}

function compactFlightRole(
  item: Pick<Assignment, "flightNo" | "position" | "remark">
): string {
  const priorityRole = concisePriorityRoles([item]);
  const role =
    priorityRole === "重点岗位"
      ? `${item.position}${item.remark ? `（${item.remark}）` : ""}`
      : priorityRole;
  return `${flightCode(item.flightNo)} ${role}`;
}

function concisePriorityRoles(
  items:
    | Array<Pick<Assignment, "position" | "remark">>
    | Array<{ position: string; remark: string }>
): string {
  const roles = PRIORITY_ROTATION_POSITION_KEYWORDS.filter((keyword) =>
    items.some((item) => `${item.position} ${item.remark}`.includes(keyword))
  );
  return roles.length ? roles.join("、") : "重点岗位";
}

function conciseProtectionReason(messages: string[]): string {
  return conciseAssignmentWarningReason(messages);
}

function positionRotationFeedback(
  state: ScheduleGenerationFacts
): ScheduleFeedbackItem {
  const unresolved = assignmentDecisionMessages(state.assignments, {
    ruleIds: new Set(["position-rotation"]),
    outcomes: new Set(["fallback"]),
  });
  if (unresolved.length) {
    return feedbackItem(
      "rule-execution",
      "position-rotation",
      "连续轮岗复核",
      "attention",
      unresolved.join("；")
    );
  }
  const fulfilled = assignmentDecisionMessages(state.assignments, {
    ruleIds: new Set(["position-rotation"]),
    outcomes: new Set(["selected"]),
  });
  if (fulfilled.length) {
    return feedbackItem(
      "rule-execution",
      "position-rotation",
      "连续轮岗复核",
      "ok",
      fulfilled.join("；")
    );
  }
  return feedbackItem(
    "rule-execution",
    "position-rotation",
    "连续轮岗复核",
    "info",
    "没有触发连续轮岗复核；上一工作班未出现同一人员承担相同航班与岗位的连续记录。"
  );
}

function crossWorkdayLoadFeedback(
  state: ScheduleGenerationFacts,
  date: string
): ScheduleFeedbackItem {
  const unresolved = assignmentDecisionMessages(state.assignments, {
    ruleIds: new Set(["cross-workday-load"]),
    outcomes: new Set(["fallback"]),
  });
  if (unresolved.length) {
    return feedbackItem(
      "rule-execution",
      "cross-workday-load",
      "跨工作班动态平衡",
      "attention",
      unresolved.join("\n")
    );
  }
  const fulfilled = assignmentDecisionMessages(state.assignments, {
    ruleIds: new Set(["cross-workday-load"]),
    outcomes: new Set(["selected"]),
  });
  if (fulfilled.length) {
    return feedbackItem(
      "rule-execution",
      "cross-workday-load",
      "跨工作班动态平衡",
      "ok",
      fulfilled.slice(0, 4).join("；")
    );
  }
  const previousDate = recentArchivedWorkdays(state.history, date, 1)[0]?.date;
  return previousDate
    ? feedbackItem(
        "rule-execution",
        "cross-workday-load",
        "跨工作班动态平衡",
        "ok",
        `${previousDate} 与本班没有出现需要由跨工作班负荷差裁决的同级候选人。`
      )
    : feedbackItem(
        "rule-execution",
        "cross-workday-load",
        "跨工作班动态平衡",
        "info",
        "暂无最近工作日归档，无法执行跨工作班动态负荷互补。"
      );
}

function positionFrequencyReviewFeedback(
  state: ScheduleGenerationFacts
): ScheduleFeedbackItem {
  const unresolved = assignmentDecisionMessages(state.assignments, {
    ruleIds: new Set(["position-frequency", "position-frequency-review"]),
    outcomes: new Set(["fallback"]),
  });
  if (unresolved.length) {
    return feedbackItem(
      "rule-execution",
      "position-frequency-review",
      "重点岗位频率均衡",
      "attention",
      unresolved.join("；")
    );
  }
  const fulfilled = assignmentDecisionMessages(state.assignments, {
    ruleIds: new Set(["position-frequency", "position-frequency-review"]),
    outcomes: new Set(["selected"]),
  });
  if (fulfilled.length) {
    return feedbackItem(
      "rule-execution",
      "position-frequency-review",
      "重点岗位频率均衡",
      "ok",
      fulfilled.join("；")
    );
  }
  return feedbackItem(
    "rule-execution",
    "position-frequency-review",
    "重点岗位频率均衡",
    "info",
    "一号、申报、督导、控制和送资料岗位未出现需要调整的同岗高频安排。"
  );
}

function currentLateFeedback(
  state: ScheduleGenerationFacts
): ScheduleFeedbackItem {
  const finalLateAssignments = state.assignments
    .filter(
      (assignment) =>
        assignment.status === "assigned" &&
        assignment.staffId &&
        assignment.workHours > 0
    )
    .filter((assignment) => isCountedWorkloadAssignment(state, assignment))
    .filter((assignment) => isLateEndingWork(assignment, state))
    .filter((assignment) =>
      matchesLateShiftRecoveryPosition(state, assignment)
    );
  const currentLate = finalLateAssignments;
  if (!state.flights.length) {
    return feedbackItem(
      "rule-execution",
      "current-late",
      "本班末班人员预告",
      "info",
      "当天没有航班，无法形成末班人员基准。"
    );
  }
  if (!currentLate.length) {
    return feedbackItem(
      "rule-execution",
      "current-late",
      "本班末班人员预告",
      "ok",
      "本班没有已安排的最后一批晚班岗位，下个工作日无需新增恢复保护人员。"
    );
  }
  const details = currentLate
    .map(
      (assignment) => `${assignment.staffName} ${compactFlightRole(assignment)}`
    )
    .join("、");
  return feedbackItem(
    "rule-execution",
    "current-late",
    "本班末班人员预告",
    "ok",
    `本班最后一批末班重点岗位人员：${details}；${conciseNames(currentLate.map((assignment) => assignment.staffName))}下个工作日需执行恢复保护。`
  );
}

function staffName(
  state: ScheduleGenerationFacts,
  staffId: string | null
): string {
  return staffId
    ? (state.staff.find((person) => person.id === staffId)?.name ??
        `#${staffId}`)
    : "未配置";
}

function assignmentSummary(
  state: ScheduleGenerationFacts,
  staffId: string | null
): string {
  if (!staffId) return "未配置";
  const latest = state.assignments
    .filter(
      (assignment) =>
        assignment.staffId === staffId &&
        assignment.status === "assigned" &&
        assignment.workHours > 0
    )
    .sort(
      (left, right) =>
        operationalStart(right.startTime, state) -
        operationalStart(left.startTime, state)
    )[0];
  return latest ? `${latest.flightNo}/${latest.position}` : "未安排实际岗位";
}

function monthlyCountDifference(counts: number[]): number {
  return counts.length ? Math.max(...counts) - Math.min(...counts) : 0;
}

function dutyRosterFeedback(
  state: ScheduleGenerationFacts,
  date: string
): ScheduleFeedbackItem {
  const roster = getDutyRosterForDate(state, date);
  const rosterIds = [
    roster.cxPreflightStaffId,
    roster.dutyStaffId,
    ...roster.standbyStaffIds,
  ].filter((id): id is string => Boolean(id));
  const cxName = staffName(state, roster.cxPreflightStaffId);
  const dutyName = staffName(state, roster.dutyStaffId);
  const dutyDescription = `值班${dutyName}（+${state.settings.dutyFatiguePoints} 点疲劳）`;
  const protectedDuty = Boolean(
    roster.dutyStaffId &&
    previousWorkdayLateProtection(state, date).protectedStaffIds.has(
      roster.dutyStaffId
    )
  );
  const dutyRecoveryNote = roster.recoveryAdjusted
    ? roster.recoveryAdjustmentRole === "future-counterpart"
      ? ` 自动值班恢复调整：本日原值班${staffName(state, roster.originalDutyStaffId ?? null)}已与 ${roster.recoverySwapDate} 的${dutyName}交换值班日期，月度值班次数不变。`
      : ` 自动值班恢复调整：原值班${staffName(state, roster.originalDutyStaffId ?? null)}已与未来工作日 ${roster.recoverySwapDate} 的${dutyName}交换值班日期，月度值班次数不变。`
    : roster.adjusted && protectedDuty
      ? ` 人工指定值班冲突：${dutyName}属于上一班末班重点岗位人员；人工指定优先，系统未自动调换值班日期。`
      : "";
  const standbyAssignments = roster.standbyStaffIds.map((staffId) => ({
    name: staffName(state, staffId),
    summary: assignmentSummary(state, staffId),
  }));
  const standbyDetails = standbyAssignments
    .map((item) => `${item.name}（${item.summary}）`)
    .join("、");
  const standbyMissingWork = standbyAssignments
    .filter((item) => item.summary === "未安排实际岗位")
    .map((item) => item.name);
  const monthlyRoster = getMonthlyDutyRoster(state, date);
  const allMonthlyStats = getMonthlyDutyRosterStats(state, date);
  const monthlyStats = allMonthlyStats.filter(
    (item) => item.staff.dutyQualified
  );
  const dutyCounts = monthlyStats.map((item) => item.dutyDates.length);
  const dutyDifference = monthlyCountDifference(dutyCounts);
  const dutyCoverageRequired =
    monthlyRoster.filter((item) => item.dutyStaffId).length >=
    monthlyStats.length;
  const monthlyMissing = monthlyStats.filter(
    (item) => item.dutyDates.length === 0
  );
  const cxStats = allMonthlyStats.filter(
    (item) => item.staff.cxPreflightQualified
  );
  const cxDifference = monthlyCountDifference(
    cxStats.map((item) => item.cxPreflightDates.length)
  );
  const standbyStats = allMonthlyStats.filter(
    (item) => item.staff.standbyQualified
  );
  const standbyIdsForMonth = new Set(standbyStats.map((item) => item.staff.id));
  const standbyDifference = monthlyCountDifference(
    standbyStats.map((item) => item.standbyDates.length)
  );
  const standbyMissing = standbyStats.filter(
    (item) => item.standbyDates.length < 2
  );
  const standbyCapacity = monthlyRoster.reduce(
    (sum, item) =>
      sum +
      Math.min(
        2,
        Math.max(
          0,
          standbyStats.length -
            (item.dutyStaffId && standbyIdsForMonth.has(item.dutyStaffId)
              ? 1
              : 0)
        )
      ),
    0
  );
  const standbySeatShortage = standbyCapacity < standbyStats.length * 2;
  const monthlyDutyNote =
    (dutyCoverageRequired && monthlyMissing.length) || dutyDifference > 1
      ? ` 月度值班需纠偏：${monthlyStats.map((item) => `${item.staff.name} ${item.dutyDates.length} 次`).join("、")}；值班次数差 ${dutyDifference}。`
      : "";
  const monthlyFairnessNote = [
    cxDifference > 1 ? `CX航前差值 ${cxDifference}` : "",
    standbyDifference > 1 ? `备勤差值 ${standbyDifference}` : "",
    standbyMissing.length && !standbySeatShortage
      ? `备勤不足 2 次：${standbyMissing.map((item) => item.staff.name).join("、")}`
      : "",
  ]
    .filter(Boolean)
    .join("、");
  const monthlyBalanceNote = monthlyFairnessNote
    ? ` 月度轮值需均衡：${monthlyFairnessNote}。`
    : "";
  const monthlyCapacityNote =
    standbyMissing.length && standbySeatShortage
      ? ` 本月工作日不足，${standbyMissing.map((item) => item.staff.name).join("、")}备勤未满 2 次；值班优先，缺额只作说明、不计违约。`
      : "";
  const morningDutyText = "12点前上午航班";
  const standbyIds = roster.standbyStaffIds.filter((id): id is string =>
    Boolean(id)
  );
  const rosterConflict =
    Boolean(
      roster.dutyStaffId &&
      [roster.cxPreflightStaffId, ...roster.standbyStaffIds].includes(
        roster.dutyStaffId
      )
    ) || new Set(standbyIds).size !== standbyIds.length;
  const standbyQualificationShortage = roster.standbyStaffIds.some(
    (staffId) => !staffId
  );
  if (rosterIds.length < 4 || rosterConflict) {
    return feedbackItem(
      "rule-execution",
      "duty-roster",
      "值班与轮值",
      "attention",
      `CX航前${cxName}；${dutyDescription}；备勤${standbyDetails}。${standbyQualificationShortage ? "备勤资质人员不足，空缺席位保持未配置；" : ""}轮值未完整配置，或值班与其他轮值发生冲突，需要调整；CX航前与备勤允许同人兼任。${morningDutyText}规则无法核验。${dutyRecoveryNote}${monthlyDutyNote}${monthlyBalanceNote}${monthlyCapacityNote}`
    );
  }
  const dutyAssignments = state.assignments.filter(
    (assignment) =>
      assignment.staffId === roster.dutyStaffId &&
      assignment.status === "assigned" &&
      assignment.workHours > 0
  );
  const morningDutyAssignment = dutyAssignments.find((assignment) =>
    isDutyMorningFlight({ startTime: assignment.startTime }, state)
  );
  const morningDutyEvidence = morningDutyAssignment
    ? `${morningDutyText}已安排在 ${morningDutyAssignment.flightNo}/${morningDutyAssignment.position}`
    : `${morningDutyText}未安排，需要复核值班人员是否在开始时间严格早于 12:00 的航班上岗`;
  if (!state.flights.length || !dutyAssignments.length) {
    return feedbackItem(
      "rule-execution",
      "duty-roster",
      "值班与轮值",
      "attention",
      `CX航前${cxName}；${dutyDescription}未安排实际航班岗位；备勤${standbyDetails}。${morningDutyEvidence}；需要复核值班人员的最晚航班安排。${dutyRecoveryNote}${monthlyDutyNote}${monthlyBalanceNote}${monthlyCapacityNote}`
    );
  }
  const latestStarts = [
    ...new Set(
      state.flights.map((flight) => operationalStart(flight.startTime, state))
    ),
  ]
    .sort((left, right) => right - left)
    .slice(0, 2);
  const configuredPreferred = [...dutyAssignments]
    .map((assignment) => ({
      assignment,
      priority: configuredDutyPositionPriority(state, assignment),
    }))
    .filter((item) => item.priority >= 0)
    .sort((left, right) => left.priority - right.priority)[0];
  if (configuredPreferred) {
    const standbyNote = standbyMissingWork.length
      ? `；${conciseNames(standbyMissingWork)}作为备勤但未安排实际岗位，需要复核`
      : "";
    const level =
      standbyMissingWork.length ||
      Boolean(monthlyDutyNote) ||
      Boolean(monthlyBalanceNote) ||
      !morningDutyAssignment
        ? "attention"
        : "ok";
    const { assignment, priority } = configuredPreferred;
    return feedbackItem(
      "rule-execution",
      "duty-roster",
      "值班与轮值",
      level,
      `CX航前${cxName}；${dutyDescription}安排在配置优先级第 ${priority + 1} 项 ${assignment.flightNo}/${assignment.position}，符合值班岗位优先顺序；${morningDutyEvidence}；备勤${standbyDetails}${standbyNote}。${dutyRecoveryNote}${monthlyDutyNote}${monthlyBalanceNote}${monthlyCapacityNote}`
    );
  }
  const preferred = [...dutyAssignments]
    .filter((assignment) =>
      latestStarts.includes(operationalStart(assignment.startTime, state))
    )
    .filter(
      (assignment) =>
        dutyLatePositionPriority(assignment.position, assignment.remark) < 4
    )
    .sort(
      (left, right) =>
        latestStarts.indexOf(operationalStart(left.startTime, state)) -
          latestStarts.indexOf(operationalStart(right.startTime, state)) ||
        dutyLatePositionPriority(left.position, left.remark) -
          dutyLatePositionPriority(right.position, right.remark)
    )[0];
  if (preferred) {
    const standbyNote = standbyMissingWork.length
      ? `；${conciseNames(standbyMissingWork)}作为备勤但未安排实际岗位，需要复核`
      : "";
    const flightRank = latestStarts.indexOf(
      operationalStart(preferred.startTime, state)
    );
    const placement =
      flightRank === 0
        ? `最晚航班 ${preferred.flightNo}/${preferred.position}`
        : `倒数第二晚航班 ${preferred.flightNo}/${preferred.position}（值班晚撤规则第二档位）`;
    const level =
      standbyMissingWork.length ||
      Boolean(monthlyDutyNote) ||
      Boolean(monthlyBalanceNote) ||
      !morningDutyAssignment
        ? "attention"
        : "ok";
    return feedbackItem(
      "rule-execution",
      "duty-roster",
      "值班与轮值",
      level,
      `CX航前${cxName}；${dutyDescription}安排在${placement}，未命中已配置优先项，按回退逻辑落位并符合值班晚撤规则；${morningDutyEvidence}；备勤${standbyDetails}${standbyNote}。${dutyRecoveryNote}${monthlyDutyNote}${monthlyBalanceNote}${monthlyCapacityNote}`
    );
  }
  const lastDuty = [...dutyAssignments].sort(
    (left, right) =>
      operationalStart(right.startTime, state) -
      operationalStart(left.startTime, state)
  )[0]!;
  const blockedDecision = assignmentDecisions(state.assignments, {
    ruleIds: new Set(["duty-position"]),
    outcomes: new Set(["blocked"]),
  })[0];
  const reason =
    blockedDecision?.message ?? "具体原因未记录，不能确定哪条限制导致未落位";
  return feedbackItem(
    "rule-execution",
    "duty-roster",
    "值班与轮值",
    "attention",
    `CX航前${cxName}；${dutyDescription}未满足值班晚撤规则：实际最晚只排到 ${lastDuty.flightNo}/${lastDuty.position}；目标岗位未落位原因：${reason}；${morningDutyEvidence}；备勤${standbyDetails}。${dutyRecoveryNote}${monthlyDutyNote}${monthlyBalanceNote}${monthlyCapacityNote}`
  );
}

export function buildRuleScheduleFeedback(
  state: ScheduleGenerationFacts,
  date: string,
  options: ScheduleFeedbackOptions = {}
): ScheduleFeedbackItem[] {
  return compileSchedulingPlan(state.settings).feedbackKeys.map((key) =>
    RULE_FEEDBACK_BUILDERS[key](state, date, options)
  );
}

type RuleFeedbackBuilder = (
  state: ScheduleGenerationFacts,
  date: string,
  options: ScheduleFeedbackOptions
) => ScheduleFeedbackItem;

const RULE_FEEDBACK_BUILDERS: Readonly<
  Record<RuleFeedbackKey, RuleFeedbackBuilder>
> = {
  "morning-priority": (state) => morningPriorityFeedback(state),
  "cross-workday-qualification-reservation": (state) =>
    crossWorkdayQualificationReservationFeedback(state),
  "high-load": (state) => highLoadFeedback(state),
  "cross-workday-load": crossWorkdayLoadFeedback,
  "position-frequency-review": (state) =>
    positionFrequencyReviewFeedback(state),
  "position-rotation": (state) => positionRotationFeedback(state),
  "previous-late": previousLateFeedback,
  "current-late": (state) => currentLateFeedback(state),
  "duty-roster": dutyRosterFeedback,
  "daily-flight-count-balance": (state, date, options) =>
    dailyFlightCountBalanceFeedback(state, date, options),
};

function dailyFlightCountBalanceFeedback(
  state: ScheduleGenerationFacts,
  date: string,
  options: ScheduleFeedbackOptions
): ScheduleFeedbackItem {
  const halfRestStaffIds = new Set(options.halfRestStaffIds ?? []);
  const dutyStaffId = getDutyRosterForDate(state, date).dutyStaffId;
  const participants = state.staff.filter(
    (person) =>
      person.status === "正常" &&
      person.staffType === "常规" &&
      person.id !== dutyStaffId &&
      !(
        state.settings.dailyFlightCountBalanceExemptHalfRest &&
        halfRestStaffIds.has(person.id)
      ) &&
      !(
        state.settings.dailyFlightCountBalanceExemptTeamLeaders &&
        person.teamLeader
      )
  );
  const participantIds = new Set(participants.map((person) => person.id));
  const assignedEntries = state.assignments.filter(
    (assignment) =>
      assignment.status === "assigned" &&
      assignment.staffId &&
      participantIds.has(assignment.staffId)
  );
  const groupedAssignments = groupStaffFlightsByNormalizedNumber(
    assignedEntries.map((assignment) => ({
      assignment,
      staffId: assignment.staffId!,
      flightNo: assignment.flightNo,
    }))
  );
  const rows = participants.map((person) => ({
    person,
    flights: groupedAssignments.get(person.id) ?? new Map(),
    count: groupedAssignments.get(person.id)?.size ?? 0,
  }));
  const maximumCount = Math.max(0, ...rows.map((row) => row.count));
  const minimumCount = rows.length
    ? Math.min(...rows.map((row) => row.count))
    : 0;
  const spread = maximumCount - minimumCount;
  const balanceVacancies = state.assignments.filter(
    (assignment) =>
      assignment.status === "unfilled" &&
      assignment.vacancyEvidence?.reason === "daily-flight-count-balance"
  );
  const noCandidateVacancies = state.assignments.filter(
    (assignment) =>
      assignment.status === "unfilled" &&
      assignment.vacancyEvidence?.reason === "no-qualified-candidate"
  );
  if (balanceVacancies.length || noCandidateVacancies.length) {
    const vacancySummary = balanceVacancies
      .map(
        (assignment) =>
          `${assignment.flightNo}/${assignment.position}：${assignment.systemNotes?.[0] ?? DAILY_FLIGHT_COUNT_BALANCE_VACANCY_NOTE}`
      )
      .join("；");
    const noCandidateSummary = noCandidateVacancies
      .map(
        (assignment) =>
          `${assignment.flightNo}/${assignment.position}：${assignment.systemNotes?.[0] ?? NO_QUALIFIED_CANDIDATE_VACANCY_NOTE}`
      )
      .join("；");
    return feedbackItem(
      "rule-execution",
      "daily-flight-count-balance",
      "同一工作班航班数均衡",
      "attention",
      `${date}航班数差值为 ${spread}；空岗检查记录：${[vacancySummary, noCandidateSummary].filter(Boolean).join("；")}`
    );
  }
  if (participants.length < 2) {
    return feedbackItem(
      "rule-execution",
      "daily-flight-count-balance",
      "同一工作班航班数均衡",
      "ok",
      `${date}参与比较的正常常规人员不足两人，不构成航班数差距。`
    );
  }
  if (spread <= 1) {
    return feedbackItem(
      "rule-execution",
      "daily-flight-count-balance",
      "同一工作班航班数均衡",
      "ok",
      `${date}参与比较 ${participants.length} 人；最多 ${maximumCount}、最少 ${minimumCount}、差距 ${spread}，在目标范围内。`
    );
  }

  const highRows = rows.filter((row) => row.count === maximumCount);
  const lowRows = rows.filter((row) => row.count === minimumCount);
  const blockerDetails = directFlightCountReplacementChecks(
    state,
    highRows,
    lowRows
  );
  const people = (items: typeof rows): string =>
    items.map((row) => `${row.person.name} ${row.count} 个`).join("、");
  const allPeople = people(rows);
  const evidence = blockerDetails.length
    ? blockerDetails.join("；")
    : "未找到可按单个航班岗位组直接替换的低航班数人员；需结合整班联动和后置调整复核。";
  return feedbackItem(
    "rule-execution",
    "daily-flight-count-balance",
    "同一工作班航班数均衡",
    "attention",
    `${date}航班数超出目标：最多 ${maximumCount}、最少 ${minimumCount}、差距 ${spread}；高航班数人员：${people(highRows)}；低航班数人员：${people(lowRows)}；全部参与人员：${allPeople}。直接替换核对：${evidence}`
  );
}

function directFlightCountReplacementChecks(
  state: ScheduleGenerationFacts,
  highRows: Array<{
    person: ScheduleGenerationFacts["staff"][number];
    flights: Map<string, Array<{ assignment: Assignment }>>;
    count: number;
  }>,
  lowRows: Array<{
    person: ScheduleGenerationFacts["staff"][number];
    flights: Map<string, Array<{ assignment: Assignment }>>;
    count: number;
  }>
): string[] {
  const details: string[] = [];
  for (const highRow of highRows) {
    for (const [flightNo, entries] of highRow.flights) {
      const bundle = entries.map((entry) => entry.assignment);
      const replacements = lowRows.map((lowRow) =>
        checkFlightBundleReplacement(state, bundle, lowRow.person)
      );
      const feasible = replacements.find((item) => item.eligible);
      const label = bundle
        .map((assignment) => `${assignment.flightNo}/${assignment.position}`)
        .join(", ");
      if (feasible) {
        details.push(
          `${highRow.person.name}的${flightNo}（${label}）可由${feasible.staffName}直接接手`
        );
      } else {
        const reasons = replacements.flatMap((item) => item.reasons);
        details.push(
          `${highRow.person.name}的${flightNo}（${label}）无低航班数人员可直接接手：${[...new Set(reasons)].slice(0, 3).join("、") || "岗位未关联可核验的当前配置规则"}`
        );
      }
    }
  }
  return details.slice(0, 4);
}

function checkFlightBundleReplacement(
  state: ScheduleGenerationFacts,
  bundle: readonly Assignment[],
  person: ScheduleGenerationFacts["staff"][number]
): { eligible: boolean; staffName: string; reasons: string[] } {
  const bundleIds = new Set(bundle.map((assignment) => assignment.id));
  const simulatedAssignments = state.assignments.filter(
    (assignment) => !bundleIds.has(assignment.id)
  );
  const reasons: string[] = [];
  for (const assignment of bundle) {
    const rule = state.positionRules.find(
      (item) => item.id === assignment.positionRuleId
    );
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    ) ?? {
      id: assignment.flightId,
      flightNo: assignment.flightNo,
      startTime: assignment.startTime,
      endTime: assignment.endTime,
      bookedPassengers: 0,
      positions: [assignment.position],
      remark: "",
    };
    if (!rule) {
      reasons.push(
        `${assignment.flightNo}/${assignment.position}无法匹配当前岗位配置`
      );
      return { eligible: false, staffName: person.name, reasons };
    }
    const diagnostic = diagnoseAutomaticAssignmentEligibility({
      state: { ...state, assignments: simulatedAssignments },
      assignments: simulatedAssignments,
      flight,
      rule,
      person,
      workHours: assignment.workHours,
    });
    if (!diagnostic.eligible) {
      reasons.push(...diagnostic.violations.map((item) => item.message));
      return { eligible: false, staffName: person.name, reasons };
    }
    simulatedAssignments.push({
      ...assignment,
      staffId: person.id,
      staffName: person.name,
    });
  }
  return { eligible: true, staffName: person.name, reasons };
}

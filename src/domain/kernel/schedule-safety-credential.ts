import type { Assignment, ScheduleResult } from "../../model";
import type { ScheduleGuardContext } from "./schedule-guard";
import { previousWorkdayLateProtection } from "../reviews/cross-day-recovery";
import { fnv64Fingerprint } from "../rules/schedule-rule-fingerprint";

const SCHEDULE_CREDENTIAL_FINGERPRINT_VERSION = "credential-v1";

export interface ScheduleSafetyCredential {
  readonly kind: "schedule-safety-credential";
  readonly phase: "final";
  readonly date: string;
  readonly assignmentsFingerprint: string;
  readonly contextFingerprint: string;
  readonly integrityFingerprint: string;
}

function fingerprint(value: unknown): string {
  return fnv64Fingerprint(value, SCHEDULE_CREDENTIAL_FINGERPRINT_VERSION);
}

function contextFingerprint(context: ScheduleGuardContext): string {
  const halfRest = context.halfRestFacts;
  const airlineRotation = context.airlineRotationFacts;
  const minimumTransition = context.minimumFlightTransitionFacts;
  const lateShiftCutoff = context.lateShiftCutoffFacts;
  const crossWorkdayReservation =
    context.crossWorkdayQualificationReservationFacts;
  const latePriorityFrequency = context.latePriorityFrequencyFacts;
  const latePriorityAggregateRotation =
    context.latePriorityAggregateRotationFacts;
  const strictNextWorkdayRecovery = context.strictNextWorkdayRecoveryFacts;
  const highFatiguePosition = context.highFatiguePositionFacts;
  const positionTransition = context.positionTransitionFacts;
  const positionFrequency = context.positionFrequencyFacts;
  const workloadBalance = context.workloadBalanceFacts;
  const sameDayLateObligation = context.sameDayLateObligationFacts;
  const lateShiftPositionRelief = context.lateShiftPositionReliefFacts;
  const mobileSupervisorCoverage = context.mobileSupervisorCoverageFacts;
  const ke166Snapshot = context.ke166SnapshotFacts;
  const scarceQualification = context.scarceQualificationFacts;
  const dutyPosition = context.dutyPositionFacts;
  const sameFlightStaffExclusion = context.sameFlightStaffExclusionFacts;
  return fingerprint({
    phase: context.phase,
    halfRestFacts: halfRest
      ? {
          requestedStaffIds: [...halfRest.requestedStaffIds],
          activeStaffIds: [...halfRest.activeStaffIds].sort(),
          minimumWorkStaffIds: [...halfRest.minimumWorkStaffIds].sort(),
          ignoredWarnings: [...halfRest.ignoredWarnings],
          modesByStaffId: [...halfRest.modesByStaffId.entries()].sort(
            ([a], [b]) => a.localeCompare(b)
          ),
          earlyFinishStaffIds: [...halfRest.earlyFinishStaffIds].sort(),
          lateStartStaffIds: [...halfRest.lateStartStaffIds].sort(),
        }
      : undefined,
    airlineRotationFacts: airlineRotation
      ? {
          enabled: airlineRotation.enabled,
          positionRules: airlineRotation.positionRules
            .map((rule) => ({
              id: rule.id,
              flightNo: rule.flightNo,
              name: rule.name,
              category: rule.category,
              remark: rule.remark,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : undefined,
    minimumFlightTransitionFacts: minimumTransition
      ? {
          minimumRegularTransitionMinutes:
            minimumTransition.settings.minimumRegularTransitionMinutes,
          nightEnd: minimumTransition.settings.nightEnd,
          flights: minimumTransition.flights
            .map((flight) => ({
              id: flight.id,
              flightNo: flight.flightNo,
              startTime: flight.startTime,
              endTime: flight.endTime,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          positionRules: minimumTransition.positionRules
            .map((rule) => ({
              id: rule.id,
              flightNo: rule.flightNo,
              category: rule.category,
              name: rule.name,
              remark: rule.remark,
              earlyReleaseMinutes: rule.earlyReleaseMinutes,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : undefined,
    lateShiftCutoffFacts: lateShiftCutoff
      ? {
          date: lateShiftCutoff.date,
          lateShiftRecoveryEnabled:
            lateShiftCutoff.state.settings.lateShiftRecoveryEnabled,
          nightEnd: lateShiftCutoff.state.settings.nightEnd,
          cutoffByStaffId: [
            ...(lateShiftCutoff.crossDayRecovery?.cutoffByStaffId.entries() ??
              []),
          ]
            .map(([staffId, protection]) => ({
              staffId,
              cutoffTime: protection.cutoffTime,
              cutoffMinutes: protection.cutoffMinutes,
              previousEndMinutes: protection.previousEndMinutes,
              sourceRecordIds: protection.sourceRecords
                .map((record) => record.id)
                .sort(),
            }))
            .sort((left, right) => left.staffId.localeCompare(right.staffId)),
        }
      : undefined,
    crossWorkdayQualificationReservationFacts: crossWorkdayReservation
      ? {
          settings: {
            lateShiftEndTime:
              crossWorkdayReservation.state.settings.lateShiftEndTime,
            nightEnd: crossWorkdayReservation.state.settings.nightEnd,
            reservations:
              crossWorkdayReservation.state.settings.crossWorkdayQualificationReservations.map(
                (reservation) => ({ ...reservation })
              ),
          },
          staff: crossWorkdayReservation.state.staff
            .map((person) => ({
              id: person.id,
              status: person.status,
              staffType: person.staffType,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          flights: crossWorkdayReservation.state.flights
            .map((flight) => ({
              id: flight.id,
              flightNo: flight.flightNo,
              startTime: flight.startTime,
              endTime: flight.endTime,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          templates: crossWorkdayReservation.state.templates
            .map((template) => ({
              id: template.id,
              flightNo: template.flightNo,
              startTime: template.startTime,
              endTime: template.endTime,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          positionRules: crossWorkdayReservation.state.positionRules
            .map((rule) => ({
              id: rule.id,
              flightNo: rule.flightNo,
              name: rule.name,
              category: rule.category,
              remark: rule.remark,
              qualifiedStaffIds: [...rule.qualifiedStaffIds].sort(),
              earlyReleaseMinutes: rule.earlyReleaseMinutes,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : undefined,
    latePriorityFrequencyFacts: latePriorityFrequency
      ? {
          date: latePriorityFrequency.date,
          settings: {
            positionRotationEnabled:
              latePriorityFrequency.state.settings.positionRotationEnabled,
            lateShiftEndTime:
              latePriorityFrequency.state.settings.lateShiftEndTime,
            latePriorityFlightNumbers: [
              ...latePriorityFrequency.state.settings.latePriorityFlightNumbers,
            ].sort(),
            nightStart: latePriorityFrequency.state.settings.nightStart,
            nightEnd: latePriorityFrequency.state.settings.nightEnd,
          },
          staff: latePriorityFrequency.state.staff
            .map((person) => ({
              id: person.id,
              status: person.status,
              staffType: person.staffType,
              nightShift: person.nightShift,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          flights: latePriorityFrequency.state.flights
            .map((flight) => ({
              id: flight.id,
              flightNo: flight.flightNo,
              startTime: flight.startTime,
              endTime: flight.endTime,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          positionRules: latePriorityFrequency.state.positionRules
            .map((rule) => ({
              id: rule.id,
              flightNo: rule.flightNo,
              category: rule.category,
              name: rule.name,
              remark: rule.remark,
              qualifiedStaffIds: [...rule.qualifiedStaffIds].sort(),
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          history: latePriorityFrequency.state.history
            .map((record) => ({ ...record }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          adjustments:
            latePriorityFrequency.state.latePriorityFrequencyAdjustments
              .map((adjustment) => ({ ...adjustment }))
              .sort((left, right) =>
                [left.month, left.staffId, left.flightNo, left.kind]
                  .join("\u0000")
                  .localeCompare(
                    [
                      right.month,
                      right.staffId,
                      right.flightNo,
                      right.kind,
                    ].join("\u0000")
                  )
              ),
          scheduleFrequency: latePriorityFrequency.scheduleFrequency
            ? {
                date: latePriorityFrequency.scheduleFrequency.date,
                recentArchivedWorkdayDates: [
                  ...latePriorityFrequency.scheduleFrequency
                    .recentArchivedWorkdayDates,
                ],
                recentConsecutiveWorkdays: [
                  ...latePriorityFrequency.scheduleFrequency
                    .recentConsecutiveWorkdays,
                ],
                recentFrequencyRecordIds: [
                  ...latePriorityFrequency.scheduleFrequency
                    .recentFrequencyRecordIds,
                ].sort(),
                recentEightWorkdayRecordIds: [
                  ...latePriorityFrequency.scheduleFrequency
                    .recentEightWorkdayRecordIds,
                ].sort(),
              }
            : undefined,
        }
      : undefined,
    latePriorityAggregateRotationFacts: latePriorityAggregateRotation
      ? {
          date: latePriorityAggregateRotation.date,
          state: {
            settings: {
              positionRotationEnabled:
                latePriorityAggregateRotation.state.settings
                  .positionRotationEnabled,
              lateShiftEndTime:
                latePriorityAggregateRotation.state.settings.lateShiftEndTime,
              latePriorityFlightNumbers: [
                ...latePriorityAggregateRotation.state.settings
                  .latePriorityFlightNumbers,
              ].sort(),
            },
            staff: latePriorityAggregateRotation.state.staff
              .map((person) => ({
                id: person.id,
                status: person.status,
                staffType: person.staffType,
                nightShift: person.nightShift,
              }))
              .sort((left, right) => left.id.localeCompare(right.id)),
            flights: latePriorityAggregateRotation.state.flights
              .map((flight) => ({
                id: flight.id,
                flightNo: flight.flightNo,
                startTime: flight.startTime,
                endTime: flight.endTime,
              }))
              .sort((left, right) => left.id.localeCompare(right.id)),
            positionRules: latePriorityAggregateRotation.state.positionRules
              .map((rule) => ({
                id: rule.id,
                flightNo: rule.flightNo,
                category: rule.category,
                name: rule.name,
                remark: rule.remark,
                qualifiedStaffIds: [...rule.qualifiedStaffIds].sort(),
              }))
              .sort((left, right) => left.id.localeCompare(right.id)),
            history: latePriorityAggregateRotation.state.history
              .map((record) => ({ ...record }))
              .sort((left, right) => left.id.localeCompare(right.id)),
            adjustments:
              latePriorityAggregateRotation.state.latePriorityFrequencyAdjustments
                .map((adjustment) => ({ ...adjustment }))
                .sort((left, right) =>
                  [left.month, left.staffId, left.flightNo, left.kind]
                    .join("\u0000")
                    .localeCompare(
                      [
                        right.month,
                        right.staffId,
                        right.flightNo,
                        right.kind,
                      ].join("\u0000")
                    )
                ),
          },
        }
      : undefined,
    strictNextWorkdayRecoveryFacts: strictNextWorkdayRecovery
      ? {
          date: strictNextWorkdayRecovery.date,
          settings: {
            lateShiftRecoveryEnabled:
              strictNextWorkdayRecovery.state.settings.lateShiftRecoveryEnabled,
            nextWorkdayRecoveryMode:
              strictNextWorkdayRecovery.state.settings.nextWorkdayRecoveryMode,
            lateShiftRecoveryPositionRules:
              strictNextWorkdayRecovery.state.settings.lateShiftRecoveryPositionRules.map(
                (rule) => ({ ...rule })
              ),
            nextWorkdayRecoveryTargets:
              strictNextWorkdayRecovery.state.settings.nextWorkdayRecoveryTargets.map(
                (target) => ({ ...target })
              ),
          },
          staff: strictNextWorkdayRecovery.state.staff
            .map((person) => ({
              id: person.id,
              status: person.status,
              staffType: person.staffType,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          flights: strictNextWorkdayRecovery.state.flights
            .map((flight) => ({
              id: flight.id,
              flightNo: flight.flightNo,
              startTime: flight.startTime,
              endTime: flight.endTime,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          positionRules: strictNextWorkdayRecovery.state.positionRules
            .map((rule) => ({
              id: rule.id,
              flightNo: rule.flightNo,
              name: rule.name,
              category: rule.category,
              remark: rule.remark,
              qualifiedStaffIds: [...rule.qualifiedStaffIds].sort(),
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          protectedStaffIds: [
            ...(strictNextWorkdayRecovery.crossDayRecovery?.previousWorkday
              ?.protectedStaffIds ??
              previousWorkdayLateProtection(
                strictNextWorkdayRecovery.state,
                strictNextWorkdayRecovery.date
              ).protectedStaffIds),
          ].sort(),
        }
      : undefined,
    highFatiguePositionFacts: highFatiguePosition
      ? {
          date: highFatiguePosition.date,
          highLoadFatigueThreshold:
            highFatiguePosition.state.settings.highLoadFatigueThreshold,
          positionRotationEnabled:
            highFatiguePosition.state.settings.positionRotationEnabled,
          staff: highFatiguePosition.state.staff
            .map((person) => ({
              id: person.id,
              status: person.status,
              staffType: person.staffType,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          flights: highFatiguePosition.state.flights
            .map((flight) => ({
              id: flight.id,
              flightNo: flight.flightNo,
              startTime: flight.startTime,
              endTime: flight.endTime,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          positionRules: highFatiguePosition.state.positionRules
            .map((rule) => ({
              id: rule.id,
              flightNo: rule.flightNo,
              name: rule.name,
              category: rule.category,
              remark: rule.remark,
              fatiguePoints: rule.fatiguePoints,
              qualifiedStaffIds: [...rule.qualifiedStaffIds].sort(),
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          scheduleFrequencyDate: highFatiguePosition.scheduleFrequency?.date,
          recentArchivedWorkdayDates: highFatiguePosition.scheduleFrequency
            ? [
                ...highFatiguePosition.scheduleFrequency
                  .recentArchivedWorkdayDates,
              ]
            : undefined,
          recentFrequencyRecordIds: highFatiguePosition.scheduleFrequency
            ? [
                ...highFatiguePosition.scheduleFrequency
                  .recentFrequencyRecordIds,
              ].sort()
            : undefined,
        }
      : undefined,
    positionTransitionFacts: positionTransition
      ? {
          positionTransitionPolicies:
            positionTransition.state.settings.positionTransitionPolicies.map(
              (policy) => ({
                ...policy,
                sourcePositions: [...policy.sourcePositions],
              })
            ),
        }
      : undefined,
    positionFrequencyFacts: positionFrequency
      ? {
          date: positionFrequency.date,
          positionRotationEnabled:
            positionFrequency.state.settings.positionRotationEnabled,
          staff: positionFrequency.state.staff
            .map((person) => ({
              id: person.id,
              status: person.status,
              staffType: person.staffType,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          flights: positionFrequency.state.flights
            .map((flight) => ({
              id: flight.id,
              flightNo: flight.flightNo,
              startTime: flight.startTime,
              endTime: flight.endTime,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          positionRules: positionFrequency.state.positionRules
            .map((rule) => ({
              id: rule.id,
              flightNo: rule.flightNo,
              name: rule.name,
              category: rule.category,
              remark: rule.remark,
              qualifiedStaffIds: [...rule.qualifiedStaffIds].sort(),
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          history: positionFrequency.state.history
            .map((record) => ({ ...record }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : undefined,
    workloadBalanceFacts: workloadBalance
      ? {
          date: workloadBalance.date,
          dutyStaffId: workloadBalance.dutyStaffId ?? null,
          settings: {
            workloadBalanceEnabled:
              workloadBalance.state.settings.workloadBalanceEnabled,
            maxWorkHoursDifference:
              workloadBalance.state.settings.maxWorkHoursDifference,
            maxTodayFatigueDifference:
              workloadBalance.state.settings.maxTodayFatigueDifference,
            historyWindowDays: workloadBalance.state.settings.historyWindowDays,
          },
          staff: workloadBalance.state.staff
            .map((person) => ({
              id: person.id,
              status: person.status,
              staffType: person.staffType,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          history: workloadBalance.state.history
            .map((record) => ({ ...record }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : undefined,
    sameDayLateObligationFacts: sameDayLateObligation
      ? {
          date: sameDayLateObligation.date,
          lateShiftEndTime:
            sameDayLateObligation.state.settings.lateShiftEndTime,
        }
      : undefined,
    lateShiftPositionReliefFacts: lateShiftPositionRelief
      ? { date: lateShiftPositionRelief.date }
      : undefined,
    mobileSupervisorCoverageFacts: mobileSupervisorCoverage
      ? {
          date: mobileSupervisorCoverage.date,
          mobileSupervisorCoverageRules:
            mobileSupervisorCoverage.state.settings.mobileSupervisorCoverageRules.map(
              (rule) => ({ ...rule })
            ),
          mobileSupervisorFillRules:
            mobileSupervisorCoverage.state.settings.mobileSupervisorFillRules.map(
              (rule) => ({ ...rule })
            ),
          fillPositionRules: mobileSupervisorCoverage.state.positionRules
            .filter((rule) => rule.coverageRole === "supervisor-fill")
            .map((rule) => ({
              id: rule.id,
              flightNo: rule.flightNo,
              name: rule.name,
              category: rule.category,
              coverageRole: rule.coverageRole,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : undefined,
    ke166SnapshotFacts: ke166Snapshot
      ? {
          date: ke166Snapshot.date,
          flightIds: ke166Snapshot.state.flights
            .map((flight) => flight.id)
            .sort(),
          positionRuleIds: ke166Snapshot.state.positionRules
            .map((rule) => rule.id)
            .sort(),
        }
      : undefined,
    scarceQualificationFacts: scarceQualification
      ? {
          date: scarceQualification.date,
          staffIds: scarceQualification.state.staff
            .map((person) => person.id)
            .sort(),
          positionRules: scarceQualification.state.positionRules
            .map((rule) => ({
              id: rule.id,
              qualifiedStaffIds: [...rule.qualifiedStaffIds].sort(),
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : undefined,
    dutyPositionFacts: dutyPosition
      ? {
          date: dutyPosition.date,
          dutyPositionPriorities:
            dutyPosition.state.settings.dutyPositionPriorities.map(
              (priority) => ({ ...priority })
            ),
        }
      : undefined,
    sameFlightStaffExclusionFacts: sameFlightStaffExclusion
      ? {
          exclusions: [
            ...sameFlightStaffExclusion.state.settings
              .sameFlightStaffExclusions,
          ]
            .map((exclusion) => ({ ...exclusion }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          staffIds: sameFlightStaffExclusion.state.staff
            .map((person) => person.id)
            .sort(),
        }
      : undefined,
  });
}

export function createScheduleSafetyCredential(options: {
  date: string;
  assignments: readonly Assignment[];
  context: ScheduleGuardContext;
}): ScheduleSafetyCredential {
  if (options.context.phase !== "final") {
    throw new Error("安全凭证只能由 final 阶段生成");
  }
  return Object.freeze({
    kind: "schedule-safety-credential" as const,
    phase: "final" as const,
    date: options.date,
    assignmentsFingerprint: fingerprint(options.assignments),
    contextFingerprint: contextFingerprint(options.context),
    integrityFingerprint: fingerprint({
      kind: "schedule-safety-credential",
      phase: "final",
      date: options.date,
      assignmentsFingerprint: fingerprint(options.assignments),
      contextFingerprint: contextFingerprint(options.context),
    }),
  });
}

export function assertScheduleSafetyCredential(options: {
  date: string;
  result: ScheduleResult;
}): void {
  const credential = options.result.safetyCredential;
  if (!credential) throw new Error("排班结果缺少安全凭证，拒绝安装");
  if (
    credential.kind !== "schedule-safety-credential" ||
    credential.phase !== "final" ||
    credential.date !== options.date ||
    credential.assignmentsFingerprint !==
      fingerprint(options.result.assignments) ||
    !credential.contextFingerprint ||
    credential.integrityFingerprint !==
      fingerprint({
        kind: credential.kind,
        phase: credential.phase,
        date: credential.date,
        assignmentsFingerprint: credential.assignmentsFingerprint,
        contextFingerprint: credential.contextFingerprint,
      })
  ) {
    throw new Error("排班结果安全凭证无效或上下文不一致，拒绝安装");
  }
}

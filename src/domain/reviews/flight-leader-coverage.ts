import type { Assignment } from "../../model";
import type { FinalScheduleReviewContext } from "../rules/rule-registry";
import { flightLeaderCoverage } from "../rules/flight-leader-coverage";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import { isRotationLocked } from "./rotation-review-safety";
import { groupStaffFlightsByNormalizedNumber } from "../statistics/staff-flight-count";
import {
  preservesStaffWorkContinuity,
  staffWorkContinuity,
} from "./staff-work-continuity";
import { preservesMix, staffAirlineMix } from "./staff-airline-mix";
import {
  preservesLateAirlineRotation,
  staffLateAirlineRotation,
} from "./late-airline-rotation";
import { preservesRelaxedShiftBalance } from "./relaxed-shift-balance";
import { rebuildAutomaticAssignmentEvidence } from "../assignments/assignment-evidence";
import { applyConfiguredEarlyReleases } from "../assignments/assignment-timing";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import { ScheduleGuardError } from "../kernel/schedule-guard";

const REVIEW_BUDGET_MS = 4000;

/** Lowest-priority improvement. No jobs are added, and all old protections win. */
export async function improveFlightLeaderCoverage(
  context: FinalScheduleReviewContext
): Promise<Assignment[]> {
  const { state, date, facts } = context;
  let current = structuredClone([...context.assignments]);
  if (!state.settings.flightLeaderCoverageEnabled) return current;
  const deadline = Date.now() + REVIEW_BUDGET_MS;
  const leaders = new Set(
    state.staff
      .filter((p) => p.flightLeaderQualified === true && p.status === "正常")
      .map((p) => p.id)
  );
  for (const target of flightLeaderCoverage(state, current)) {
    // Each accepted plan reduces the shortfall by at least one: bounded by real staff.
    for (
      let attempt = 0;
      attempt < state.staff.length && Date.now() < deadline;
      attempt++
    ) {
      const before = flightLeaderCoverage(state, current);
      if (
        before.find((f) => f.flightId === target.flightId)!.actual >=
        target.required
      )
        break;
      const grouped = groupStaffFlightsByNormalizedNumber(
        current.flatMap((a) =>
          a.status === "assigned" && a.staffId
            ? [{ staffId: a.staffId, flightNo: a.flightNo, assignment: a }]
            : []
        )
      );
      const groups = [...grouped.values()]
        .flatMap((flights) =>
          [...flights.values()].map((rows) => rows.map((r) => r.assignment))
        )
        .filter((rows) =>
          rows.every(
            (a) =>
              state.staff.find((p) => p.id === a.staffId)?.staffType ===
                "常规" &&
              !a.manualRemark &&
              !a.countBaseline &&
              !a.teamLeaderGapFill &&
              !isRotationLocked(state, a, context.lockedAssignmentIds)
          )
        );
      const primaries = groups
        .flat()
        .filter(
          (a) => a.flightId === target.flightId && !leaders.has(a.staffId!)
        );
      let improved = false;
      for (const [index, primary] of primaries.entries()) {
        if (Date.now() >= deadline) break;
        let accepted: Assignment[] | undefined;
        const result = await optimizeReassignment({
          state,
          date,
          facts,
          solver: context.solver,
          assignments: current,
          primary,
          movableAssignments: groups.flat(),
          coupledAssignmentGroups: groups.map((rows) => rows.map((a) => a.id)),
          intent: { kind: "flight-leader-coverage-review" },
          primaryCandidateAllowed: (p) => leaders.has(p.id),
          candidateAllowed: (_a, p) => p.staffType === "常规",
          preserveStaffAssignmentCounts: true,
          maxParticipants: 5,
          timeoutMs: Math.max(
            1,
            Math.floor((deadline - Date.now()) / (primaries.length - index))
          ),
          validateChanges: (changes) => {
            const proposal = structuredClone(current),
              incoming = new Map(
                changes.map((c) => [c.assignmentId, c.staffId])
              );
            const changed = new Set<string>();
            for (const a of proposal) {
              const id = incoming.get(a.id);
              if (!id || id === a.staffId) continue;
              changed.add(a.staffId!);
              changed.add(id);
              a.staffId = id;
              a.staffName = state.staff.find((p) => p.id === id)!.name;
              rebuildAutomaticAssignmentEvidence(a, [
                schedulingDecision(
                  "flight-leader-coverage",
                  "selected",
                  "保留原规则，通过安全换人改善航班负责人人数。"
                ),
              ]);
            }
            applyConfiguredEarlyReleases(proposal, state, changed);
            // Keep individual load identical, including when the original balance
            // switch is off: this preference cannot buy coverage with more work.
            for (const staffId of changed) {
              for (const field of ["workHours", "fatiguePoints"] as const) {
                const total = (rows: Assignment[]) =>
                  rows
                    .filter(
                      (a) => a.status === "assigned" && a.staffId === staffId
                    )
                    .reduce((sum, a) => sum + a[field], 0);
                if (Math.abs(total(proposal) - total(current)) > 1e-6)
                  return ["负责人保障不改变个人已有工时或疲劳负荷"];
              }
            }
            const after = flightLeaderCoverage(state, proposal);
            if (
              after.some(
                (f) =>
                  Math.max(0, f.required - f.actual) >
                  Math.max(
                    0,
                    before.find((b) => b.flightId === f.flightId)!.required -
                      before.find((b) => b.flightId === f.flightId)!.actual
                  )
              ) ||
              after.find((f) => f.flightId === target.flightId)!.actual <=
                before.find((f) => f.flightId === target.flightId)!.actual
            )
              return ["负责人缺口未改善或被转移到另一航班"];
            if (
              !preservesStaffWorkContinuity(
                staffWorkContinuity(state, current, facts.currentDutyStaffId),
                staffWorkContinuity(state, proposal, facts.currentDutyStaffId)
              ) ||
              !preservesRelaxedShiftBalance(state, date, current, proposal) ||
              !preservesMix(
                staffAirlineMix(state, current),
                staffAirlineMix(state, proposal)
              ) ||
              !preservesLateAirlineRotation(
                staffLateAirlineRotation(state, current, date),
                staffLateAirlineRotation(state, proposal, date)
              )
            )
              return [
                "负责人保障不能使原有休息、任务集中、航司搭配或末班交替退步",
              ];
            try {
              context.assertSafe(proposal);
            } catch (error) {
              if (error instanceof ScheduleGuardError)
                return ["最终安全检查未通过，保留原安排"];
              throw error;
            }
            accepted = proposal;
            return [];
          },
        });
        if (result.changes && accepted) {
          current = accepted;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
  }
  return current;
}

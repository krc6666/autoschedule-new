import type { ScheduleResult } from "../../model";
import type { DailySchedulePlan } from "./daily-schedule-result";

function planKey(plan: DailySchedulePlan): string {
  const keys = new Map(
    plan.assignments.map((row) => [
      row.id,
      `${row.flightId}:${row.positionRuleId ?? row.position}`,
    ])
  );
  return JSON.stringify({
    ...plan,
    lockedAssignmentIds: [...plan.lockedAssignmentIds]
      .map((id) => keys.get(id) ?? id)
      .sort(),
    assignments: plan.assignments.map((row) => ({
      ...row,
      id: keys.get(row.id),
      supervisorSourceAssignmentId:
        row.supervisorSourceAssignmentId &&
        (keys.get(row.supervisorSourceAssignmentId) ??
          row.supervisorSourceAssignmentId),
    })),
  });
}

/** Coalesces identical solver snapshots; every published result still takes
 * the complete finalization/safety path. Owns no scheduling rules. */
export function createScheduleCheckpointQueue(
  finalize: (plan: DailySchedulePlan) => Promise<ScheduleResult>,
  publish: (result: ScheduleResult) => void
) {
  let pending: { key: string; plan: DailySchedulePlan } | null = null;
  let running = false;
  let closed = false;
  let lastSuccessfulKey: string | null = null;
  let runningKey: string | null = null;
  const processLatest = async () => {
    running = true;
    try {
      while (!closed && pending) {
        const current = pending;
        pending = null;
        runningKey = current.key;
        try {
          const result = await finalize(current.plan);
          lastSuccessfulKey = current.key;
          if (!closed) publish(result);
        } catch {
          // Failure never publishes an unchecked plan; a later plan can retry.
        }
        runningKey = null;
      }
    } finally {
      running = false;
    }
  };
  return {
    enqueue(plan: DailySchedulePlan) {
      if (closed) return;
      const key = planKey(plan);
      if (key === pending?.key) return;
      if (key === runningKey || key === lastSuccessfulKey) {
        pending = null;
        return;
      }
      pending = { key, plan: structuredClone(plan) };
      if (!running) void processLatest();
    },
    discardPending() {
      pending = null;
    },
    close() {
      closed = true;
      pending = null;
    },
  };
}

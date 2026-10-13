import { afterEach, expect, it, vi } from "vitest";
import { createLatePriorityPressureState } from "../performance/fixtures/late-priority";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { createTestAutoscheduleStore } from "../helpers/application";
import { createStatePersistence } from "../../src/infrastructure/storage";

afterEach(() => vi.unstubAllGlobals());

it("uses real Worker handler and WASM with late history, supervision and safe checkpoints", async () => {
  const { state, date } = createLatePriorityPressureState();
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.positionTransitionPolicies = [];
  state.settings.crossFlightPriorityPolicies = [];
  state.settings.crossWorkdayQualificationReservations = [];
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.history = state.history.map((row) =>
    row.flightNo === "TR121" && row.remark === "一号"
      ? { ...row, position: "H02", remark: "申报" }
      : row
  );
  state.positionRules
    .filter((rule) => rule.name === "督导")
    .forEach((rule) => (rule.category = "机动督导"));
  const messages: ScheduleWorkerResponse[] = [];
  const worker: {
    onmessage:
      ((event: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
    postMessage: (message: ScheduleWorkerResponse) => void;
  } = {
    onmessage: null,
    postMessage: (message) => messages.push(structuredClone(message)),
  };
  vi.stubGlobal("self", worker);
  await import("../../src/schedule.worker");
  await worker.onmessage!(
    new MessageEvent<ScheduleWorkerRequest>("message", {
      data: {
        state: createScheduleGenerationFacts(state),
        date,
        preferences: { halfRestStaffIds: [], halfRestModes: {} },
      },
    })
  );
  expect(messages.filter((message) => message.type === "error")).toEqual([]);
  const final = messages.find((message) => message.type === "result");
  if (final?.type !== "result") throw new Error("没有最终结果");
  expect(final.result.assignments).toHaveLength(8);
  expect(final.result.unfilledCount).toBe(0);
  expect(final.result.safetyCredential?.phase).toBe("final");
  const checkpoints = messages.filter(
    (message) => message.type === "safe-result"
  );
  expect(checkpoints.length).toBeGreaterThan(0);
  for (const checkpoint of checkpoints)
    if (checkpoint.type === "safe-result")
      expect(checkpoint.result.safetyCredential?.phase).toBe("final");
  expect(messages.at(-1)?.type).toBe("result");
  const store = createTestAutoscheduleStore(state);
  store.getState().schedule.install(date, final.result);
  let saved = "";
  const persistence = createStatePersistence({
    getItem: () => saved || null,
    setItem: (_key, value) => {
      saved = value;
    },
    removeItem: () => {
      saved = "";
    },
  });
  persistence.save(store.getState().model);
  expect(persistence.load().assignments).toEqual(
    store.getState().model.assignments
  );
}, 30_000);

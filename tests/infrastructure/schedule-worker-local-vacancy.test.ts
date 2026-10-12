import { afterEach, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { createTestAutoscheduleStore } from "../helpers/application";
import { createStatePersistence } from "../../src/infrastructure/storage";

afterEach(() => vi.unstubAllGlobals());

it("runs real worker/WASM with an impossible half-rest task, then stores the vacant and legal rows", async () => {
  const state = createDefaultState();
  state.staff = [0, 1].map((index) => ({
    ...state.staff[index]!,
    id: `worker-${index}`,
    name: `人员${index}`,
    status: "正常" as const,
    staffType: "常规" as const,
    teamLeader: false,
    dutyQualified: false,
    nightShift: true,
  }));
  state.flights = [0, 1].map((index) => ({
    id: `flight-${index}`,
    flightNo: `TEST${index}`,
    positions: ["柜台"],
    startTime: index ? "14:00" : "08:00",
    endTime: index ? "16:00" : "10:00",
    bookedPassengers: 200,
    remark: "",
  }));
  state.positionRules = state.flights.map((flight, index) => ({
    ...state.positionRules[0]!,
    id: `rule-${index}`,
    flightNo: flight.flightNo,
    name: "柜台",
    category: "常规" as const,
    qualifiedStaffIds: [state.staff[index]!.id],
    minPassengers: 0,
    earlyReleaseMinutes: 0,
    manual: false,
    fatiguePoints: 1,
    remark: "",
  }));
  state.history = [];
  state.dutyRosterOverrides = [];
  state.settings.positionTransitionPolicies = [];
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
        date: "2026-10-14",
        preferences: {
          halfRestStaffIds: ["worker-1"],
          halfRestModes: { "worker-1": "early-finish" },
        },
      },
    })
  );
  expect(messages.filter((message) => message.type === "error")).toEqual([]);
  const response = messages.find((message) => message.type === "result");
  if (response?.type !== "result") throw new Error("未返回班表");
  expect(
    response.result.assignments.find((row) => row.flightId === "flight-0")!
      .staffId
  ).toBe("worker-0");
  expect(
    response.result.assignments.find((row) => row.flightId === "flight-1")!
      .status
  ).toBe("unfilled");
  expect(response.result.unfilledCount).toBe(1);
  const store = createTestAutoscheduleStore(state);
  store.getState().schedule.install("2026-10-14", response.result);
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
  const restored = persistence.load();
  expect(
    restored.assignments.map((row) => [
      row.staffId,
      row.status,
      row.systemNotes,
    ])
  ).toEqual(
    response.result.assignments.map((row) => [
      row.staffId,
      row.status,
      row.systemNotes,
    ])
  );
});

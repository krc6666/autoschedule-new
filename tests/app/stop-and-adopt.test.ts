import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { ApplicationCoordinator } from "../../src/app/application-coordinator";
import { ScheduleRunController } from "../../src/app/schedule-run-controller";
import { runScheduleInBackground } from "../../src/infrastructure/schedule-runner";
import type { ScheduleWorkerResponse } from "../../src/infrastructure/schedule-worker-protocol";
import type { AppState, Assignment, ScheduleResult } from "../../src/model";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { createStatePersistence } from "../../src/infrastructure/storage";
import { createTestAutoscheduleStore } from "../helpers/application";

class ControlledWorker {
  static latest: ControlledWorker | undefined;
  onmessage: ((event: MessageEvent<ScheduleWorkerResponse>) => void) | null =
    null;
  onerror = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    ControlledWorker.latest = this;
  }
  emit(message: ScheduleWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<ScheduleWorkerResponse>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const date = "2026-11-03";
const entries = [
  { open: "generate-schedule", confirm: "confirm-schedule-preflight" },
  {
    open: "open-reschedule-flight-picker",
    confirm: "confirm-reschedule-flight-picker",
  },
  {
    open: "archive-next-duty-day",
    confirm: "confirm-next-workday-flight-picker",
  },
] as const;

function fixture(withVacancy = false) {
  const state = createDefaultState();
  state.staff = state.staff.slice(0, 2).map((p, i) => ({
    ...p,
    id: `person-${i}`,
    name: `测试${i}`,
    status: "正常" as const,
    dutyQualified: false,
    cxPreflightQualified: false,
    standbyQualified: false,
    teamLeader: false,
  }));
  const flight = {
    ...state.flights[0]!,
    flightNo: "TEST001",
    startTime: "13:00",
    endTime: "15:00",
    positions: ["G01"],
    bookedPassengers: 100,
  };
  state.flights = [flight];
  state.templates = [{ ...flight, id: "test-template" }];
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "test-rule",
      flightNo: flight.flightNo,
      name: "G01",
      category: "常规",
      manual: false,
      minPassengers: 0,
      qualifiedStaffIds: state.staff.map((p) => p.id),
    },
  ];
  if (withVacancy) {
    flight.positions.push("G02");
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "vacancy-rule",
      name: "G02",
      qualifiedStaffIds: [],
    });
  }
  state.history = [];
  state.dutyRosterOverrides = [];
  state.activeScheduleDate = date;
  state.assignments = [row(state, "original", 0)];
  return state;
}

function row(state: AppState, id: string, personIndex: number): Assignment {
  const flight = state.flights[0]!;
  const person = state.staff[personIndex]!;
  return {
    id,
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: "test-rule",
    position: "G01",
    staffId: person.id,
    staffName: person.name,
    startTime: "13:00",
    endTime: "15:00",
    workHours: 2,
    fatiguePoints: 2,
    remark: "",
    manualRemark: "",
    status: "assigned",
  };
}

function snapshot(
  state: AppState,
  resultDate: string,
  id: string,
  person: number
): ScheduleResult {
  const assignments = [row(state, id, person)];
  if (state.positionRules.some((r) => r.id === "vacancy-rule")) {
    assignments.push({
      ...row(state, `${id}-vacant`, person),
      positionRuleId: "vacancy-rule",
      position: "G02",
      staffId: null,
      staffName: "",
      status: "unfilled",
      workHours: 0,
      fatiguePoints: 0,
      systemNotes: ["没有具备这个岗位资质的人员"],
    });
  }
  const session = createScheduleSafetySession({
    phase: "final",
    state,
    date: resultDate,
    runFacts: createScheduleRunFacts(state, resultDate),
  });
  session.assertAssignmentsSafe(assignments);
  return {
    assignments,
    warnings: [],
    unfilledCount: assignments.filter((a) => a.status === "unfilled").length,
    safetyCredential: session.createCredential(resultDate, assignments),
  };
}

describe.each(entries)("停止结果完整链路：$open", (entry) => {
  it.each([
    "adopt",
    "discard",
    "not-ready",
    "tampered",
    "timeout-adopt",
    "timeout-empty",
    "timeout-tampered",
    "timeout-vacancy",
  ] as const)("%s", async (mode) => {
    const automatic = mode.startsWith("timeout-");
    if (automatic) vi.useFakeTimers();
    vi.stubGlobal("Worker", ControlledWorker);
    ControlledWorker.latest = undefined;
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => {
      values.set(key, value);
    });
    const persistence = createStatePersistence({
      getItem: (key) => values.get(key) ?? null,
      setItem,
      removeItem: (key) => {
        values.delete(key);
      },
    });
    const saveDate = vi.fn();
    let input!: AppState;
    let targetDate = "";
    const coordinator = new ApplicationCoordinator(
      createTestAutoscheduleStore(
        fixture(mode === "timeout-vacancy"),
        persistence
      ),
      {
        preferences: {
          loadScheduleDate: () => date,
          saveScheduleDate: saveDate,
          loadScheduleZoom: () => null,
          saveScheduleZoom: () => undefined,
        },
        confirm: () => true,
      },
      {
        createScheduleRunner: (callbacks) =>
          new ScheduleRunController({
            ...callbacks,
            yieldToBrowser: async () => undefined,
            run: (state, d, ...args) => {
              input = state;
              targetDate = d;
              return runScheduleInBackground(state, d, ...args);
            },
          }),
      }
    );
    const before = structuredClone(coordinator.model());
    await coordinator.handle({ type: entry.open });
    await coordinator.handle({
      type: "update-preflight-administrative-mode",
      enabled: true,
    });
    const dialog = coordinator.view().dialog;
    if (!dialog || !("candidates" in dialog)) throw new Error("缺少准备窗口");
    const pending = coordinator.handle({
      type: entry.confirm,
      selectedIds: dialog.candidates.map((c) => c.id),
    });
    await vi.waitFor(() => expect(ControlledWorker.latest).toBeDefined());
    const worker = ControlledWorker.latest!;
    expect(coordinator.model()).toEqual(before);
    expect(coordinator.scheduleRunner.isRunning()).toBe(true);
    let latest: ScheduleResult | undefined;
    if (mode !== "not-ready" && mode !== "timeout-empty") {
      worker.emit({
        type: "safe-result",
        result: snapshot(input, targetDate, "first", 0),
      });
      latest = snapshot(input, targetDate, "latest", 1);
      if (mode === "tampered" || mode === "timeout-tampered")
        latest.assignments[0]!.staffName = "改坏凭证";
      worker.emit({ type: "safe-result", result: latest });
      expect(coordinator.view().progress.canAdoptCurrentResult).toBe(true);
    }
    if (mode === "not-ready") {
      await coordinator.handle({ type: "stop-schedule-with-current-result" });
      expect(coordinator.scheduleRunner.isRunning()).toBe(true);
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(coordinator.model()).toEqual(before);
    }
    if (automatic) {
      await vi.advanceTimersByTimeAsync(600_000);
      expect(worker.terminate).toHaveBeenCalledOnce();
    } else
      await coordinator.handle({
        type:
          mode === "discard" || mode === "not-ready"
            ? "stop-schedule-without-result"
            : "stop-schedule-with-current-result",
      });
    await pending;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.scheduleRunner.isRunning()).toBe(false);
    if (
      mode === "adopt" ||
      mode === "timeout-adopt" ||
      mode === "timeout-vacancy"
    ) {
      expect(coordinator.model().assignments).toEqual(latest!.assignments);
      expect(coordinator.model().assignments[0]!.staffId).toBe("person-1");
      expect(coordinator.model().settings.adminSupportEnabled).toBe(true);
      expect(coordinator.model().activeScheduleDate).toBe(targetDate);
      expect(coordinator.view().date).toBe(targetDate);
      expect(coordinator.view().section).toBe("schedule");
      if (mode === "timeout-vacancy") {
        expect(
          coordinator.model().assignments.filter((a) => a.status === "unfilled")
        ).toHaveLength(1);
        expect(coordinator.view().toast?.details?.vacancies).toHaveLength(1);
        expect(coordinator.model().assignments[1]!.systemNotes).toContain(
          "没有具备这个岗位资质的人员"
        );
      } else expect(coordinator.view().toast?.message).toContain("采用");
      if (automatic)
        expect(coordinator.view().toast?.message).toContain("10分钟");
      expect(setItem).toHaveBeenCalledOnce();
      expect(persistence.load().assignments).toEqual(latest!.assignments);
      expect(persistence.load().settings.adminSupportEnabled).toBe(true);
      expect(coordinator.model().groups.B).toEqual(before.groups.B);
      expect(coordinator.model().weeklyFlightPlans).toEqual(
        before.weeklyFlightPlans
      );
      if (entry.open === "archive-next-duty-day") {
        expect(targetDate).toBe("2026-11-05");
        expect(saveDate).toHaveBeenCalledWith(targetDate);
        expect(coordinator.model().history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ date, staffId: "person-0" }),
          ])
        );
      } else {
        expect(saveDate).not.toHaveBeenCalled();
        expect(coordinator.model().history).toEqual(before.history);
      }
      const adopted = structuredClone(coordinator.model());
      worker.emit({
        type: "result",
        result: snapshot(input, targetDate, "late", 0),
      });
      expect(coordinator.model()).toEqual(adopted);
    } else {
      expect(coordinator.model()).toEqual(before);
      expect(coordinator.view().date).toBe(date);
      expect(saveDate).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
      expect(coordinator.view().toast?.tone).toBe(
        mode === "tampered" || mode === "timeout-tampered"
          ? "danger"
          : "warning"
      );
      if (mode === "timeout-empty")
        expect(coordinator.view().toast?.message).toContain("10分钟");
    }
  });
});

describe.each(["mode-change", "staff-status"] as const)(
  "即时重算10分钟采用：%s",
  (entry) => {
    it("uses the shared timeout result and keeps the applied configuration", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("Worker", ControlledWorker);
      ControlledWorker.latest = undefined;
      let input!: AppState;
      let targetDate = "";
      const coordinator = new ApplicationCoordinator(
        createTestAutoscheduleStore(fixture()),
        {
          preferences: {
            loadScheduleDate: () => date,
            saveScheduleDate: () => undefined,
            loadScheduleZoom: () => null,
            saveScheduleZoom: () => undefined,
          },
          confirm: () => true,
        },
        {
          createScheduleRunner: (callbacks) =>
            new ScheduleRunController({
              ...callbacks,
              yieldToBrowser: async () => undefined,
              run: (state, d, ...args) => {
                input = state;
                targetDate = d;
                return runScheduleInBackground(state, d, ...args);
              },
            }),
        }
      );
      const pending =
        entry === "mode-change"
          ? coordinator.handle({
              type: "toggle-administrative-mode",
              enabled: true,
            })
          : coordinator.handle({
              type: "update-configuration",
              entity: "staff",
              id: "person-0",
              field: "status",
              value: "休假",
            });
      await vi.waitFor(() => expect(ControlledWorker.latest).toBeDefined());
      const worker = ControlledWorker.latest!;
      const latest = snapshot(input, targetDate, "latest", 1);
      worker.emit({ type: "safe-result", result: latest });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(worker.terminate).toHaveBeenCalledOnce();
      await pending;
      expect(coordinator.model().assignments).toEqual(latest.assignments);
      expect(coordinator.model().activeScheduleDate).toBe(date);
      expect(coordinator.view().toast?.message).toContain("10分钟");
      expect(coordinator.scheduleRunner.isRunning()).toBe(false);
      if (entry === "mode-change")
        expect(coordinator.model().settings.adminSupportEnabled).toBe(true);
      else expect(coordinator.model().staff[0]!.status).toBe("休假");
    });
  }
);

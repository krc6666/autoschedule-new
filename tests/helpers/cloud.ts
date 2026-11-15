import { vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { AppState } from "../../src/model";
import {
  CloudError,
  type CloudBackend,
  type CloudPublication,
} from "../../src/app/cloud-contract";
import { createAutoscheduleStore } from "../../src/app/store/autoschedule-store";

export class MemoryCloudStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

export function cloudModel(): AppState {
  const model = createDefaultState();
  const store = createAutoscheduleStore({
    initialState: model,
    persistence: {
      load: () => model,
      save: (state) => ({ state, sizeBytes: 0, nearCapacity: false }),
      clear: () => {},
    },
  });
  return structuredClone(store.getState().model);
}

export function publishableCloudModel(): AppState {
  const model = cloudModel();
  const flight = model.flights[0]!;
  model.activeScheduleDate = "2026-11-15";
  model.assignments = [
    {
      id: "example-manual",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: null,
      position: "临时岗位",
      staffId: null,
      staffName: "",
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 0,
      fatiguePoints: 0,
      remark: "示例待补位",
      manualRemark: "",
      status: "manual",
    },
  ];
  model.groups.A.activeScheduleDate = model.activeScheduleDate;
  model.groups.A.assignments = structuredClone(model.assignments);
  return model;
}

export function cloudFixture(model = cloudModel()) {
  let version = 1;
  let saved = structuredClone(model);
  let signedOut: () => void = () => {};
  let user: string | null = "admin";
  const publication: CloudPublication = {
    token: "00000000-0000-4000-8000-000000000099",
    snapshot: {
      schemaVersion: 1,
      groupId: "A",
      date: "2026-11-15",
      publishedAt: "2026-11-15T00:00:00Z",
      rows: [],
    },
  };
  const backend = {
    currentUser: vi.fn(async () => user),
    signIn: vi.fn(async (_email: string, _password: string) => {
      user = "admin";
    }),
    signOut: vi.fn(async () => {
      user = null;
      signedOut();
    }),
    onSignedOut: vi.fn((callback: () => void) => {
      signedOut = callback;
      return () => {
        signedOut = () => {};
      };
    }),
    load: vi.fn<CloudBackend["load"]>(async () => ({
      version,
      model: structuredClone(saved),
    })),
    save: vi.fn(async (expected: number, next: AppState) => {
      if (expected !== version)
        throw new CloudError("conflict", "WORKSPACE_CONFLICT");
      saved = structuredClone(next);
      return ++version;
    }),
    publish: vi.fn(async (_expected: number, _group: "A" | "B") => publication),
    readPublication: vi.fn(async (_token: string) => publication.snapshot),
  } satisfies CloudBackend;
  return {
    backend,
    publication,
    setUser: (id: string | null) => {
      user = id;
    },
    expire: () => signedOut(),
  };
}

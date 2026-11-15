import { describe, expect, it } from "vitest";
import {
  createBrowserCloudPersistence,
  readCloudRecoveryFile,
} from "../../src/infrastructure/cloud-recovery-store";
import { CloudWorkspace } from "../../src/app/cloud-workspace";
import { cloudFixture, cloudModel, MemoryCloudStorage } from "../helpers/cloud";

describe("cloud recovery and migration boundary", () => {
  it("round-trips the actual recovery JSON for both groups without duplicating a full baseline", async () => {
    const storage = new MemoryCloudStorage();
    const persistence = createBrowserCloudPersistence(
      "project",
      "admin",
      storage
    );
    const model = cloudModel();
    model.groups.B.staff = [
      { ...model.staff[0]!, id: "B-recovery-person", name: "B组恢复示例" },
    ];
    model.settings.workloadBalanceEnabled = false;
    model.settings.maxTodayFatigueDifference = 0;
    model.settings.airlineMixPolicies = [];
    model.groups.A.settings = structuredClone(model.settings);
    const { backend } = cloudFixture(model);
    const workspace = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence.recovery
    );
    workspace.store.getState().configuration.addStaff();
    workspace.stash();
    const bytes = persistence.recovery.raw()!;
    const stored = JSON.parse(bytes);
    expect(Object.keys(stored).sort()).toEqual([
      "baseVersion",
      "model",
      "unsaved",
    ]);
    expect(stored.model.groups.A.staff.length).toBe(
      model.groups.A.staff.length + 1
    );
    expect(
      stored.model.groups.B.staff.map((person: { id: string }) => person.id)
    ).toEqual(["B-recovery-person"]);
    expect(stored.model.settings.workloadBalanceEnabled).toBe(false);
    expect(stored.model.settings.maxTodayFatigueDifference).toBe(0);
    expect(stored.model.settings.airlineMixPolicies).toEqual([]);
    const exported = workspace.recoveryJson();
    const read = await readCloudRecoveryFile({ text: async () => exported });
    expect(read.groups.A.staff.length).toBe(stored.model.groups.A.staff.length);
    expect(read.groups.B.staff[0]!.id).toBe("B-recovery-person");
    expect(storage.getItem("autoschedule.state.v1")).toBeNull();
    workspace.dispose();
  });

  it("never replaces damaged original local data with sample defaults during first migration", () => {
    const storage = new MemoryCloudStorage();
    storage.setItem("autoschedule.state.v1", "{invalid-json");
    const persistence = createBrowserCloudPersistence(
      "project",
      "admin",
      storage
    );
    expect(() => persistence.loadLocalModel()).toThrow();
    expect(storage.getItem("autoschedule.state.v1")).toBe("{invalid-json");
  });

  it("rejects a damaged root in cache and recovery files while retaining the original bytes", async () => {
    const storage = new MemoryCloudStorage();
    const recovery = createBrowserCloudPersistence(
      "project",
      "admin",
      storage
    ).recovery;
    const damaged = JSON.parse(JSON.stringify(cloudModel()));
    delete damaged.staff;
    const bytes = JSON.stringify({
      baseVersion: 1,
      unsaved: true,
      model: damaged,
    });
    storage.setItem("autoschedule.cloud.v1:project:admin:recovery", bytes);
    expect(() => recovery.read()).toThrow("顶层资料");
    expect(recovery.raw()).toBe(bytes);
    await expect(
      readCloudRecoveryFile({ text: async () => bytes })
    ).rejects.toThrow("顶层资料");
  });

  it("rejects partial JSON and reports cache quota failure without claiming the cloud failed", async () => {
    await expect(
      readCloudRecoveryFile({ text: async () => '{"model":{}}' })
    ).rejects.toThrow();
    const { backend } = cloudFixture();
    const store = createBrowserCloudPersistence(
      "project",
      "admin",
      new MemoryCloudStorage()
    ).recovery;
    store.write = () => {
      throw new Error("quota");
    };
    const workspace = new CloudWorkspace(backend, await backend.load(), store);
    workspace.store.getState().configuration.addStaff();
    await workspace.save();
    expect(workspace.cloudVersion).toBe(2);
    expect(workspace.hasUnsavedChanges).toBe(false);
    expect(workspace.cacheWarning).toContain("云端已保存");
    expect(JSON.parse(workspace.recoveryJson()).model.staff.length).toBe(
      workspace.store.getState().model.staff.length
    );
    workspace.dispose();
  });
});

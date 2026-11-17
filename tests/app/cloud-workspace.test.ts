import { describe, expect, it } from "vitest";
import { CloudWorkspace } from "../../src/app/cloud-workspace";
import { createBrowserCloudPersistence } from "../../src/infrastructure/cloud-recovery-store";
import {
  cloudFixture,
  cloudModel,
  publishableCloudModel,
  MemoryCloudStorage,
} from "../helpers/cloud";

describe("cloud workspace lifecycle", () => {
  const persistence = (
    storage = new MemoryCloudStorage(),
    user = "admin",
    project = "project"
  ) => createBrowserCloudPersistence(project, user, storage);

  it("keeps local save/export separate from cloud success and restores unsent changes after reload", async () => {
    const storage = new MemoryCloudStorage();
    const { backend } = cloudFixture();
    const workspace = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence(storage).recovery
    );
    expect(workspace.hasUnsavedChanges).toBe(false);
    workspace.store.getState().configuration.addStaff();
    workspace.store.getState().persist();
    workspace.store.getState().markExported();
    expect(workspace.hasUnsavedChanges).toBe(true);
    expect(backend.save).not.toHaveBeenCalled();
    const restored = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence(storage).recovery
    );
    expect(restored.hasUnsavedChanges).toBe(true);
    expect(restored.store.getState().model.staff.length).toBe(
      workspace.store.getState().model.staff.length
    );
    await restored.save();
    expect(restored.cloudVersion).toBe(2);
    expect(restored.hasUnsavedChanges).toBe(false);
    const nextDevice = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence().recovery
    );
    expect(nextDevice.store.getState().model.staff.length).toBe(
      restored.store.getState().model.staff.length
    );
    expect(nextDevice.hasUnsavedChanges).toBe(false);
    workspace.dispose();
    restored.dispose();
    nextDevice.dispose();
  });

  it("rejects stale devices and keeps their recovery bytes instead of overwriting either copy", async () => {
    const { backend } = cloudFixture();
    const storage = new MemoryCloudStorage();
    const remote = await backend.load();
    const first = new CloudWorkspace(backend, remote, persistence().recovery);
    const oldDevice = new CloudWorkspace(
      backend,
      remote,
      persistence(storage).recovery
    );
    first.store.getState().configuration.addStaff();
    await first.save();
    oldDevice.store.getState().configuration.addStaff();
    oldDevice.store.getState().configuration.addStaff();
    await expect(oldDevice.save()).rejects.toThrow("WORKSPACE_CONFLICT");
    const raw = persistence(storage).recovery.raw();
    const reload = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence(storage).recovery
    );
    expect(reload.recoveryConflict).toBe(true);
    await expect(reload.save()).rejects.toThrow();
    expect(reload.recoveryJson()).toBe(raw);
    expect(persistence(storage).recovery.raw()).toBe(raw);
    reload.discardRecovery();
    expect(reload.recoveryConflict).toBe(false);
    expect(reload.store.getState().model.staff.length).toBe(
      first.store.getState().model.staff.length
    );
    first.dispose();
    oldDevice.dispose();
    reload.dispose();
  });

  it("restores using current CAS and writes the new recovery baseline; later local edits still need upload", async () => {
    const { backend } = cloudFixture();
    const cache = persistence().recovery;
    const workspace = new CloudWorkspace(backend, await backend.load(), cache);
    workspace.store.getState().configuration.addStaff();
    const restored = cloudModel();
    restored.staff[0]!.remark = restored.groups.A.staff[0]!.remark = "restored";
    backend.restoreVersion.mockResolvedValue({ version: 2, model: restored });
    await workspace.restoreVersion("1");
    expect(backend.restoreVersion).toHaveBeenCalledWith(1, "1", "test-session");
    expect(workspace.cloudVersion).toBe(2);
    expect(workspace.hasUnsavedChanges).toBe(false);
    expect(cache.read()).toMatchObject({
      baseVersion: 2,
      unsaved: false,
      model: restored,
    });
    workspace.store.getState().configuration.addStaff();
    expect(workspace.hasUnsavedChanges).toBe(true);
    workspace.dispose();
  });

  it("reports a local cache failure separately after a successful cloud restore", async () => {
    const { backend } = cloudFixture();
    backend.restoreVersion.mockResolvedValue({
      version: 2,
      model: cloudModel(),
    });
    const cache = persistence().recovery;
    const workspace = new CloudWorkspace(backend, await backend.load(), {
      ...cache,
      write: () => {
        throw new Error("disk full");
      },
    });
    await workspace.restoreVersion("1");
    expect(workspace.cloudVersion).toBe(2);
    expect(workspace.hasUnsavedChanges).toBe(false);
    expect(workspace.cacheWarning).toContain("云端已恢复");
    workspace.dispose();
  });

  it("does not call publication for unsaved, empty or stale schedules", async () => {
    const { backend } = cloudFixture();
    const workspace = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence().recovery
    );
    await expect(workspace.publish()).rejects.toThrow("有效班表");
    workspace.store.getState().configuration.addStaff();
    await expect(workspace.publish()).rejects.toThrow("先保存");
    expect(backend.publish).not.toHaveBeenCalled();
    backend.save.mockRejectedValueOnce(new Error("offline"));
    await expect(workspace.save()).rejects.toThrow("offline");
    expect(workspace.hasUnsavedChanges).toBe(true);
    expect(workspace.cloudVersion).toBe(1);
    workspace.dispose();
  });

  it("keeps projects, users, original local data and preflight memories isolated", () => {
    const storage = new MemoryCloudStorage();
    storage.setItem("autoschedule.state.v1", "original-local-bytes");
    const one = persistence(storage);
    one.preferences.saveScheduleDate("2026-11-15");
    one.recovery.write({ baseVersion: 1, unsaved: true, model: cloudModel() });
    expect(persistence(storage, "other").recovery.read()).toBeNull();
    expect(
      persistence(storage, "admin", "other-project").recovery.read()
    ).toBeNull();
    expect(
      persistence(storage, "other").preferences.loadScheduleDate()
    ).toBeNull();
    expect(storage.getItem("autoschedule.state.v1")).toBe(
      "original-local-bytes"
    );
  });

  it("requires explicit first migration and never replaces an existing remote workspace", () => {
    const { backend } = cloudFixture();
    const empty = new CloudWorkspace(
      backend,
      { version: 0, model: null },
      persistence().recovery
    );
    expect(backend.save).not.toHaveBeenCalled();
    const local = cloudModel();
    local.staff[0]!.name = "migration example";
    empty.importLocal(local);
    expect(empty.store.getState().model.staff[0]!.name).toBe(
      "migration example"
    );
    expect(empty.hasUnsavedChanges).toBe(true);
    const existing = new CloudWorkspace(
      backend,
      { version: 1, model: cloudModel() },
      persistence().recovery
    );
    expect(() => existing.importLocal(local)).toThrow("空云端");
    empty.dispose();
    existing.dispose();
  });

  it("keeps damaged recovery bytes and rejects duplicate requests", async () => {
    const storage = new MemoryCloudStorage();
    storage.setItem(
      "autoschedule.cloud.v1:project:admin:recovery",
      "broken-json"
    );
    const { backend } = cloudFixture();
    const damaged = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence(storage).recovery
    );
    expect(damaged.recoveryConflict).toBe(true);
    expect(damaged.recoveryJson()).toBe("broken-json");
    const normal = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence().recovery
    );
    let finish!: (version: number) => void;
    backend.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const saving = normal.save();
    await expect(normal.save()).rejects.toThrow("当前操作");
    finish(2);
    await saving;
    expect(normal.busy).toBe(false);
    damaged.dispose();
    normal.dispose();
  });

  it("publishes only an unchanged saved current group and retains edit state on publication failure", async () => {
    const { backend, publication } = cloudFixture(publishableCloudModel());
    const workspace = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence().recovery
    );
    expect(await workspace.publish()).toEqual(publication);
    expect(backend.publish).toHaveBeenCalledWith(1, "A", "test-session");
    backend.publish.mockRejectedValueOnce(new Error("offline"));
    await expect(workspace.publish()).rejects.toThrow("offline");
    expect(workspace.cloudVersion).toBe(1);
    expect(workspace.hasUnsavedChanges).toBe(false);
    workspace.dispose();
  });

  it("ignores jsonb object key ordering and restores backup data without restoring old version metadata", async () => {
    const storage = new MemoryCloudStorage();
    const { backend } = cloudFixture();
    const workspace = new CloudWorkspace(
      backend,
      await backend.load(),
      persistence(storage).recovery
    );
    const reordered = JSON.parse(
      JSON.stringify(workspace.store.getState().model),
      (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value
    );
    workspace.store.getState().replaceModel(reordered);
    expect(workspace.hasUnsavedChanges).toBe(false);
    const copy = cloudModel();
    copy.staff[0]!.name = "恢复示例";
    workspace.restoreRecovery(copy);
    expect(workspace.cloudVersion).toBe(1);
    expect(workspace.hasUnsavedChanges).toBe(true);
    expect(workspace.store.getState().model.staff[0]!.name).toBe("恢复示例");
    workspace.dispose();
  });
});

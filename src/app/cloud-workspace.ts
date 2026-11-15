import { createDefaultState } from "../defaults";
import type { AppState } from "../model";
import {
  CloudError,
  type CloudBackend,
  type CloudPublication,
} from "./cloud-contract";
import {
  createAutoscheduleStore,
  type AutoscheduleStore,
} from "./store/autoschedule-store";
import type {
  CloudRecoveryStore,
  RecoveryCopy,
} from "../infrastructure/cloud-recovery-store";

export function workspaceFingerprint(model: AppState): string {
  const { updatedAt: _updatedAt, ...facts } = model;
  // PostgreSQL jsonb reorders object keys; property order is not a user edit.
  return JSON.stringify(facts, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
        )
      : value
  );
}

/** Coordinates one editor. Database CAS remains authoritative across devices. */
export class CloudWorkspace {
  readonly store: AutoscheduleStore;
  private baseline: string;
  private version: number;
  private pending = false;
  private conflict = false;
  private recovery: RecoveryCopy | null = null;
  cacheWarning = "";
  onChange: () => void = () => {};
  private readonly unsubscribe: () => void;

  constructor(
    private readonly backend: CloudBackend,
    remote: { version: number; model: AppState | null },
    private readonly cache: CloudRecoveryStore
  ) {
    this.version = remote.version;
    let initial = remote.model ?? createDefaultState();
    this.baseline = remote.model ? workspaceFingerprint(initial) : "";
    try {
      const value = cache.read();
      if (value) {
        const model = value.model;
        this.recovery = value;
        const hasEdits = value.unsaved;
        if (hasEdits && value.baseVersion !== remote.version) {
          this.conflict = true;
        } else if (hasEdits) {
          initial = model;
        } else {
          this.recovery = null;
        }
      }
    } catch {
      // Keep unreadable bytes downloadable; never silently overwrite them.
      this.conflict = true;
      this.cacheWarning =
        "本机恢复副本无法完整读取，请先下载副本，再选择使用云端数据。";
    }
    this.store = createAutoscheduleStore({
      initialState: initial,
      persistence: {
        load: () => initial,
        save: (model) => {
          this.writeCache(model);
          return {
            state: model,
            sizeBytes: new Blob([JSON.stringify(model)]).size,
            nearCapacity: false,
          };
        },
        clear: () => {
          /* Reset affects editor only; explicit cloud save is still required. */
        },
      },
    });
    // Store initialization reconciles group projections. Use that same shape as baseline.
    if (remote.model && !this.recovery)
      this.baseline = workspaceFingerprint(this.store.getState().model);
    this.unsubscribe = this.store.subscribe(() => this.onChange());
  }

  get busy(): boolean {
    return this.pending;
  }
  get recoveryConflict(): boolean {
    return this.conflict;
  }
  get cloudVersion(): number {
    return this.version;
  }
  get hasUnsavedChanges(): boolean {
    return (
      this.conflict ||
      workspaceFingerprint(this.store.getState().model) !== this.baseline
    );
  }

  private writeCache(model: AppState): void {
    if (this.conflict)
      throw new CloudError("conflict", "本机旧恢复副本尚未处理，未覆盖它。");
    this.cache.write({
      baseVersion: this.version,
      unsaved: workspaceFingerprint(model) !== this.baseline,
      model,
    });
    this.cacheWarning = "";
  }

  stash(): void {
    this.writeCache(this.store.getState().model);
  }

  recoveryJson(): string {
    if (this.conflict) return this.cache.raw() ?? "";
    return JSON.stringify(
      { baseVersion: this.version, model: this.store.getState().model },
      null,
      2
    );
  }

  discardRecovery(): void {
    // Called only after explicit user confirmation; remote model stays untouched.
    this.cache.remove();
    this.conflict = false;
    this.recovery = null;
    this.cacheWarning = "";
    this.onChange();
  }

  importLocal(model: AppState): void {
    if (this.version !== 0 || this.pending || this.conflict)
      throw new CloudError("invalid", "只有空云端工作区可以接收首次本机迁移。");
    this.store.getState().replaceModel(model);
    this.stash();
  }

  restoreRecovery(model: AppState): void {
    if (this.pending || this.conflict)
      throw new CloudError(
        "conflict",
        "请先处理本机旧副本或等待当前操作完成。"
      );
    // The current remote version stays authoritative; old file versions never replace it.
    this.store.getState().replaceModel(model);
    this.stash();
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending || this.conflict)
      throw new CloudError("conflict", "请先完成当前操作或处理本机恢复副本。");
    this.pending = true;
    this.onChange();
    try {
      return await operation();
    } finally {
      this.pending = false;
      this.onChange();
    }
  }

  async save(): Promise<void> {
    return this.run(async () => {
      const snapshot = structuredClone(this.store.getState().model);
      try {
        this.stash();
      } catch {
        this.cacheWarning = "本机恢复副本保存失败，请下载副本备份。";
      }
      const nextVersion = await this.backend.save(this.version, snapshot);
      this.version = nextVersion;
      this.baseline = workspaceFingerprint(snapshot);
      try {
        this.stash();
      } catch {
        this.cacheWarning = "云端已保存，但本机恢复副本未更新，请下载备份。";
      }
    });
  }

  async publish(): Promise<CloudPublication> {
    return this.run(async () => {
      if (this.hasUnsavedChanges)
        throw new CloudError("invalid", "请先保存到云端，再发布班表。");
      const model = this.store.getState().model;
      if (
        !model.activeScheduleDate ||
        !model.assignments.length ||
        model.schedulePolicyStale
      ) {
        throw new CloudError(
          "invalid",
          "当前没有可发布的有效班表，请先重新排班。"
        );
      }
      return this.backend.publish(this.version, model.activeGroupId);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }
}

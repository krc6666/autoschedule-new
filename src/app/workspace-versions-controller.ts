import type { CloudBackend } from "./cloud-contract";
import type { WorkspaceVersion } from "./workspace-version-contract";

export interface WorkspaceVersionsView {
  loading: boolean;
  loaded: boolean;
  error: string;
  entries: WorkspaceVersion[];
}

/** Transient history query state, scoped to the authenticated editor. */
export class WorkspaceVersionsController {
  view: WorkspaceVersionsView = {
    loading: false,
    loaded: false,
    error: "",
    entries: [],
  };
  onChange: (view: WorkspaceVersionsView) => void = () => {};
  private disposed = false;
  constructor(private readonly backend: Pick<CloudBackend, "listVersions">) {}
  private update(patch: Partial<WorkspaceVersionsView>): void {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.onChange(this.view);
  }
  async load(): Promise<void> {
    if (this.disposed || this.view.loading) return;
    this.update({ loading: true, error: "" });
    try {
      this.update({ entries: await this.backend.listVersions(), loaded: true });
    } catch (error) {
      this.update({
        error:
          error instanceof Error
            ? error.message
            : "历史版本暂时无法读取，请重试。",
      });
    } finally {
      this.update({ loading: false });
    }
  }
  dispose(): void {
    this.disposed = true;
    this.view = { loading: false, loaded: false, error: "", entries: [] };
    this.onChange = () => {};
  }
}

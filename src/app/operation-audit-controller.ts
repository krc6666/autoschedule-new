import type { CloudBackend } from "./cloud-contract";
import type { AuditDetails, AuditEntry } from "./operation-audit-contract";

export interface AuditDetailView {
  open: boolean;
  loading: boolean;
  error: string;
  data: AuditDetails | null;
}
export interface OperationAuditView {
  loading: boolean;
  loaded: boolean;
  error: string;
  entries: AuditEntry[];
  nextCursor: string | null;
  details: Record<string, AuditDetailView>;
}

/** Query state belongs to the current authenticated session, never the workspace. */
export class OperationAuditController {
  view: OperationAuditView = {
    loading: false,
    loaded: false,
    error: "",
    entries: [],
    nextCursor: null,
    details: {},
  };
  onChange: (view: OperationAuditView) => void = () => {};
  private generation = 0;
  private disposed = false;
  constructor(
    private readonly backend: Pick<CloudBackend, "listAudit" | "auditDetails">
  ) {}

  private update(patch: Partial<OperationAuditView>): void {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.onChange(this.view);
  }
  private detail(id: string, patch: Partial<AuditDetailView>): void {
    this.update({
      details: {
        ...this.view.details,
        [id]: {
          open: true,
          loading: false,
          error: "",
          data: null,
          ...this.view.details[id],
          ...patch,
        },
      },
    });
  }
  async load(more = false): Promise<void> {
    if (this.disposed || this.view.loading || (more && !this.view.nextCursor))
      return;
    const generation = more ? this.generation : ++this.generation;
    const cursor = more ? this.view.nextCursor : null;
    this.update({ loading: true, error: "", ...(more ? {} : { details: {} }) });
    try {
      const page = await this.backend.listAudit(cursor);
      if (this.disposed || generation !== this.generation) return;
      this.update({
        entries: more ? [...this.view.entries, ...page.entries] : page.entries,
        nextCursor: page.nextCursor,
        loaded: true,
      });
    } catch (error) {
      if (generation === this.generation)
        this.update({
          error:
            error instanceof Error
              ? error.message
              : "操作记录暂时无法读取，请重试。",
        });
    } finally {
      if (generation === this.generation) this.update({ loading: false });
    }
  }
  async expand(id: string, more = false): Promise<void> {
    if (this.disposed || !this.view.entries.some((entry) => entry.id === id))
      return;
    const current = this.view.details[id];
    if (current?.loading) return;
    if (!more && current?.open && current.data && !current.error) {
      this.detail(id, { open: false });
      return;
    }
    if (!more && current?.data && !current.error) {
      this.detail(id, { open: true });
      return;
    }
    if (more && !current?.data?.nextCursor) return;
    const generation = this.generation;
    this.detail(id, { open: true, loading: true, error: "" });
    try {
      const data = await this.backend.auditDetails(
        id,
        more ? current!.data!.nextCursor! : 0
      );
      if (this.disposed || generation !== this.generation) return;
      this.detail(id, {
        data: {
          ...data,
          changes: more
            ? [...current!.data!.changes, ...data.changes]
            : data.changes,
        },
      });
    } catch (error) {
      if (generation === this.generation)
        this.detail(id, {
          error:
            error instanceof Error
              ? error.message
              : "修改详情暂时无法读取，请重试。",
        });
    } finally {
      if (generation === this.generation) this.detail(id, { loading: false });
    }
  }
  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.view = {
      loading: false,
      loaded: false,
      error: "",
      entries: [],
      nextCursor: null,
      details: {},
    };
    this.onChange = () => {};
  }
}

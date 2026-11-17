import { html } from "lit";
import type { WorkspaceVersionsView } from "../../app/workspace-versions-controller";
import { LightDomElement } from "./light-dom-element";

export type WorkspaceVersionsCommand =
  { type: "back" | "refresh" } | { type: "restore"; id: string };
export class WorkspaceVersionsPageElement extends LightDomElement {
  static override properties = {
    view: { attribute: false },
    busy: { type: Boolean },
    canRestore: { type: Boolean },
  };
  view!: WorkspaceVersionsView;
  busy = false;
  canRestore = true;
  private command(command: WorkspaceVersionsCommand): void {
    this.dispatchEvent(
      new CustomEvent("versions-command", { detail: command, bubbles: true })
    );
  }
  protected override render() {
    const view = this.view;
    if (!view) return null;
    return html`<main class="operation-audit-page" aria-label="历史版本">
      <header class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h1 class="h4 mb-0 me-auto">历史版本</h1>
        <button
          class="btn btn-outline-secondary btn-sm"
          data-cloud-action="versions-refresh"
          ?disabled=${this.busy || view.loading}
          @click=${() => this.command({ type: "refresh" })}
        >
          刷新历史
        </button>
        <button
          class="btn btn-outline-secondary btn-sm"
          data-cloud-action="versions-back"
          ?disabled=${this.busy}
          @click=${() => this.command({ type: "back" })}
        >
          返回工作台
        </button>
      </header>
      <p class="small text-secondary">
        每次云端保存前自动留档，保留最近20个旧版本。显示原保存时间和当时上传账号，时间按当前设备时区显示。恢复会替换A/B两组及共用资料，并先备份当前云端资料；已发布班表需另行发布。共用账号无法区分实际使用者。
      </p>
      ${view.error ? html`<div class="alert alert-danger" role="alert">${view.error}，请点击“刷新历史”重试。</div>` : null}
      ${view.loading ? html`<div role="status">正在读取历史版本…</div>` : null}
      ${this.busy ? html`<div role="status">正在处理，请勿关闭页面…</div>` : null}
      ${view.loaded && !view.loading && !view.error && !view.entries.length ? html`<div class="alert alert-light">暂无历史版本；功能启用后，覆盖保存时开始留档。</div>` : null}
      ${view.entries.map(
        (entry) =>
          html`<article
            class="operation-audit-entry d-flex flex-wrap align-items-center gap-2"
          >
            <time datetime=${entry.createdAt}
              >${new Date(entry.createdAt).toLocaleString("zh-CN", { hourCycle: "h23" })}</time
            >
            <strong class="audit-account"
              >${entry.actor ?? "启用前版本，上传账号未知"}</strong
            >
            <span class="small text-secondary">版本 ${entry.version}</span>
            <button
              class="btn btn-outline-secondary btn-sm ms-auto"
              data-cloud-action=${`version-restore-${entry.id}`}
              ?disabled=${this.busy || view.loading || !this.canRestore}
              @click=${() => this.command({ type: "restore", id: entry.id })}
            >
              恢复此版本
            </button>
          </article>`
      )}
    </main>`;
  }
}
customElements.define(
  "autoschedule-workspace-versions",
  WorkspaceVersionsPageElement
);

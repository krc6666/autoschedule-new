import { html } from "lit";
import type { OperationAuditView } from "../../app/operation-audit-controller";
import { projectAuditChange } from "../projections/operation-audit-view";
import { LightDomElement } from "./light-dom-element";

export type AuditPageCommand =
  | { type: "refresh" | "more" | "back" }
  | { type: "expand" | "details-more"; id: string };
export class OperationAuditPageElement extends LightDomElement {
  static override properties = { view: { attribute: false } };
  view!: OperationAuditView;
  private command(command: AuditPageCommand): void {
    this.dispatchEvent(
      new CustomEvent("audit-command", { detail: command, bubbles: true })
    );
  }
  protected override render() {
    const view = this.view;
    if (!view) return null;
    return html`<main class="operation-audit-page" aria-label="操作记录">
      <header class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h1 class="h4 mb-0 me-auto">操作记录</h1>
        <button
          class="btn btn-outline-secondary btn-sm"
          data-cloud-action="audit-refresh"
          ?disabled=${view.loading}
          @click=${() => this.command({ type: "refresh" })}
        >
          刷新记录
        </button>
        <button
          class="btn btn-outline-secondary btn-sm"
          data-cloud-action="workspace"
          @click=${() => this.command({ type: "back" })}
        >
          返回工作台
        </button>
      </header>
      <p class="small text-secondary">
        记录成功保存到云端的实际修改。时间以当前设备时区显示，查看页面不留记录；保存前改了又改回的内容不记。记录从功能启用后开始。
      </p>
      ${view.error ? html`<div class="alert alert-danger" role="alert">${view.error}<button class="btn btn-link btn-sm" ?disabled=${view.loading} @click=${() => this.command({ type: view.loaded && view.nextCursor ? "more" : "refresh" })}>重试</button></div>` : null}
      ${view.loading ? html`<div role="status" class="text-secondary my-3">正在读取操作记录…</div>` : null}
      ${view.loaded && !view.loading && !view.error && !view.entries.length ? html`<div class="alert alert-light">暂无操作记录</div>` : null}
      <div class="operation-audit-list">
        ${view.entries.map((entry) => {
          const detail = view.details[entry.id];
          const occurredAt = new Date(entry.occurredAt).toLocaleString(
            "zh-CN",
            {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            }
          );
          return html`<article class="operation-audit-entry">
            <div class="d-flex flex-wrap align-items-center gap-2">
              <time datetime=${entry.occurredAt}>${occurredAt}</time>
              <strong class="audit-account">${entry.actor}</strong
              ><span class="small text-secondary"
                >保存版本 ${entry.version} · ${entry.changeCount} 项变化</span
              >
              <button
                class="btn btn-link btn-sm ms-auto"
                data-cloud-action=${`audit-expand-${entry.id}`}
                aria-expanded=${Boolean(detail?.open)}
                ?disabled=${detail?.loading ?? false}
                @click=${() => this.command({ type: "expand", id: entry.id })}
              >
                ${detail?.open ? "收起详情" : "查看修改"}
              </button>
            </div>
            ${
              detail?.open
                ? html`<div class="operation-audit-details">
                    ${detail.error ? html`<div role="alert" class="text-danger">${detail.error}<button class="btn btn-link btn-sm" @click=${() => this.command({ type: detail.data?.nextCursor ? "details-more" : "expand", id: entry.id })}>重试详情</button></div>` : null}
                    ${detail.data?.changes.map((change) => {
                      const projected = projectAuditChange(
                        change,
                        detail.data!.staffLabels
                      );
                      if (!projected.lines.length) return null;
                      return html`<section class="operation-audit-change">
                        <h2 class="h6">
                          ${projected.action}：${projected.title}
                        </h2>
                        <ul class="operation-audit-text">
                          ${projected.lines.map(
                            (line) =>
                              html`<li>
                                <time datetime=${entry.occurredAt}
                                  >${occurredAt}</time
                                >：${line}
                              </li>`
                          )}
                        </ul>
                      </section>`;
                    })}
                    ${detail.loading ? html`<div role="status">正在读取修改详情…</div>` : null}
                    ${detail.data?.nextCursor ? html`<button class="btn btn-outline-secondary btn-sm" data-cloud-action=${`audit-details-more-${entry.id}`} ?disabled=${detail.loading} @click=${() => this.command({ type: "details-more", id: entry.id })}>继续查看本次修改</button>` : null}
                  </div>`
                : null
            }
          </article>`;
        })}
      </div>
      ${view.nextCursor ? html`<button class="btn btn-outline-secondary mt-3" data-cloud-action="audit-more" ?disabled=${view.loading} @click=${() => this.command({ type: "more" })}>查看更早记录</button>` : null}
    </main>`;
  }
}
customElements.define(
  "autoschedule-operation-audit",
  OperationAuditPageElement
);

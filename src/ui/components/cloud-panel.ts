import { html, type PropertyValues } from "lit";
import type { CloudSaveFeedback } from "../../app/cloud-contract";
import { LightDomElement } from "./light-dom-element";

export type CloudCommand =
  | { type: "login"; email: string; password: string }
  | { type: "restore"; file: File }
  | {
      type:
        | "save"
        | "publish"
        | "logout"
        | "import-local"
        | "download"
        | "discard"
        | "retry";
    };

export interface CloudPanelState {
  phase: "loading" | "login" | "editor" | "error";
  busy: boolean;
  message: string;
  notice: "info" | "error" | null;
  saveFeedback: CloudSaveFeedback;
  dirty: boolean;
  version: number;
  conflict: boolean;
  canImport: boolean;
  cacheWarning: string;
  shareUrl: string;
}

const FAILURE_LABELS = {
  unavailable: "网络或服务暂不可用",
  unauthorized: "权限问题",
  conflict: "版本冲突",
  invalid: "数据校验未通过",
  unknown: "原因待确认",
} as const;

export class CloudPanelElement extends LightDomElement {
  static override properties = { state: { attribute: false } };
  state!: CloudPanelState;
  private showSaveTime = false;
  private timeTimer: number | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.ownerDocument.addEventListener("pointerdown", this.outsidePointer);
    this.ownerDocument.addEventListener("keydown", this.escapeMenu);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.ownerDocument.removeEventListener("pointerdown", this.outsidePointer);
    this.ownerDocument.removeEventListener("keydown", this.escapeMenu);
    window.clearTimeout(this.timeTimer);
    this.timeTimer = undefined;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("state")) return;
    const before = changed.get("state")?.saveFeedback;
    const next = this.state?.saveFeedback;
    if (
      next?.phase === "saved" &&
      (before?.phase !== "saved" || before.savedAt !== next.savedAt)
    ) {
      window.clearTimeout(this.timeTimer);
      this.showSaveTime = true;
      this.timeTimer = window.setTimeout(() => {
        this.showSaveTime = false;
        this.timeTimer = undefined;
        this.requestUpdate();
      }, 5_000);
    } else if (next?.phase !== "saved") {
      window.clearTimeout(this.timeTimer);
      this.timeTimer = undefined;
      this.showSaveTime = false;
    }
  }

  private closeMenu(): void {
    const menu = this.querySelector("details");
    if (menu) menu.open = false;
  }

  private readonly outsidePointer = (event: Event): void => {
    if (event.target instanceof Node && !this.contains(event.target))
      this.closeMenu();
  };

  private readonly escapeMenu = (event: KeyboardEvent): void => {
    const menu = this.querySelector("details");
    if (event.key === "Escape" && menu?.open) {
      this.closeMenu();
      menu.querySelector("summary")?.focus();
    }
  };

  private command(command: CloudCommand): void {
    this.closeMenu();
    this.dispatchEvent(
      new CustomEvent<CloudCommand>("cloud-command", {
        detail: command,
        bubbles: true,
      })
    );
  }

  private saveStatus() {
    const s = this.state;
    const feedback = s.saveFeedback;
    let title = "";
    let content;
    let tone = "neutral";
    if (feedback.phase === "saving") {
      content = html`<i
          class="bi bi-arrow-repeat cloud-save-spin"
          aria-hidden="true"
        ></i
        ><span>正在保存到云端...</span>`;
    } else if (feedback.phase === "failed") {
      title = feedback.message;
      tone = "failed";
      content = html`<i class="bi bi-x-circle" aria-hidden="true"></i
        ><button
          class="cloud-save-retry"
          ?disabled=${s.busy || s.conflict}
          @click=${() => this.command({ type: "save" })}
        >
          保存失败，点击重试</button
        ><span class="cloud-save-reason"
          >${FAILURE_LABELS[feedback.kind]}</span
        >`;
    } else if (s.dirty) {
      content = html`<i
          class="bi bi-circle-fill cloud-unsaved-dot"
          aria-hidden="true"
        ></i
        ><span>有修改未上传</span>`;
      if (feedback.phase === "saved")
        title = `上次保存：${new Date(feedback.savedAt).toLocaleString("zh-CN", { hourCycle: "h23" })}`;
    } else if (feedback.phase === "saved") {
      const date = new Date(feedback.savedAt);
      const time = date.toLocaleTimeString("zh-CN", {
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      title = `保存于 ${date.toLocaleDateString("zh-CN")} ${time}`;
      tone = "saved";
      content = html`<i class="bi bi-check2" aria-hidden="true"></i
        ><span
          >已保存${this.showSaveTime ? html` <time datetime=${date.toISOString()}>${time}</time>` : null}</span
        >`;
    } else {
      content = html`<i class="bi bi-cloud-check" aria-hidden="true"></i
        ><span>已与云端同步</span>`;
    }
    return html`<div
      class="cloud-save-status cloud-save-${tone}"
      data-cloud-save-status
      role="status"
      aria-live="polite"
      aria-atomic="true"
      title=${title}
    >
      ${content}
    </div>`;
  }

  protected override render() {
    const s = this.state;
    if (!s) return null;
    return html`<section class="cloud-panel" aria-label="云端工作区">
      <div class="cloud-toolbar">
        <span class="cloud-workspace-label"
          ><i class="bi bi-cloud" aria-hidden="true"></i>云端工作区</span
        >
        ${
          s.phase === "editor"
            ? html` <button
                  class="btn btn-primary btn-sm cloud-save-button"
                  data-cloud-action="save"
                  ?disabled=${s.busy || s.conflict}
                  @click=${() => this.command({ type: "save" })}
                >
                  保存到云端
                </button>
                ${this.saveStatus()}
                <details class="cloud-more">
                  <summary aria-label="更多操作" title="更多操作">…</summary>
                  <div
                    class="cloud-more-menu"
                    role="group"
                    aria-label="云端更多操作"
                  >
                    <button
                      data-cloud-action="publish"
                      ?disabled=${s.busy || s.conflict || s.dirty}
                      @click=${() => this.command({ type: "publish" })}
                    >
                      发布当前组班表
                    </button>
                    <button
                      data-cloud-action="download"
                      ?disabled=${s.busy}
                      @click=${() => this.command({ type: "download" })}
                    >
                      下载恢复副本
                    </button>
                    <button
                      data-cloud-action="restore"
                      ?disabled=${s.busy || s.conflict}
                      @click=${() => {
                        this.closeMenu();
                        this.querySelector<HTMLInputElement>(
                          "input[data-cloud-restore]"
                        )?.click();
                      }}
                    >
                      导入恢复副本
                    </button>
                    <input
                      data-cloud-restore
                      type="file"
                      hidden
                      accept=".json,application/json"
                      ?disabled=${s.busy || s.conflict}
                      @change=${this.restore}
                    />
                    <button
                      data-cloud-action="logout"
                      ?disabled=${s.busy}
                      @click=${() => this.command({ type: "logout" })}
                    >
                      退出登录
                    </button>
                    ${s.shareUrl ? html`<label class="cloud-share-link">查看链接<input class="form-control form-control-sm" readonly .value=${s.shareUrl} @focus=${(event: FocusEvent) => (event.target as HTMLInputElement).select()} /></label>` : null}
                  </div>
                </details>`
            : null
        }
      </div>
      ${s.phase === "loading" ? html`<div class="cloud-panel-notice" role="status">正在连接云端...</div>` : null}
      ${
        s.phase === "login"
          ? html`<form
              class="d-flex flex-wrap gap-2 mt-3"
              @submit=${this.login}
            >
              <label
                >管理员邮箱<input
                  name="email"
                  class="form-control"
                  type="email"
                  autocomplete="username"
                  required
                  ?disabled=${s.busy}
              /></label>
              <label
                >密码<input
                  name="password"
                  class="form-control"
                  type="password"
                  autocomplete="current-password"
                  required
                  ?disabled=${s.busy}
              /></label>
              <button
                class="btn btn-primary align-self-end"
                type="submit"
                ?disabled=${s.busy}
              >
                登录
              </button>
            </form>`
          : null
      }
      ${s.message && (s.phase === "error" || s.phase === "login" || s.notice) ? html`<div class="cloud-panel-notice" role=${s.notice === "error" || s.phase === "error" ? "alert" : "status"}>${s.message}</div>` : null}
      ${s.conflict ? html`<div class="cloud-panel-notice" role="alert">云端版本已变化，编辑已暂停。<button class="btn btn-link btn-sm" ?disabled=${s.busy} @click=${() => this.command({ type: "discard" })}>放弃本机未保存修改，使用云端内容</button></div>` : null}
      ${s.phase === "error" ? html`<div class="d-flex gap-2 mt-2"><button class="btn btn-outline-secondary btn-sm" ?disabled=${s.busy} @click=${() => this.command({ type: "retry" })}>重新连接</button><button class="btn btn-link btn-sm" ?disabled=${s.busy} @click=${() => this.command({ type: "logout" })}>退出当前登录</button></div>` : null}
    </section>`;
  }

  private login(event: SubmitEvent): void {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const command: CloudCommand = {
      type: "login",
      email: String(values.get("email") ?? "").trim(),
      password: String(values.get("password") ?? ""),
    };
    form.reset();
    this.command(command);
  }

  private restore(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) this.command({ type: "restore", file });
  }
}

customElements.define("autoschedule-cloud-panel", CloudPanelElement);

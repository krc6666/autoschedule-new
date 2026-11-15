import { html } from "lit";
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
  dirty: boolean;
  version: number;
  conflict: boolean;
  canImport: boolean;
  cacheWarning: string;
  shareUrl: string;
}

export class CloudPanelElement extends LightDomElement {
  static override properties = { state: { attribute: false } };
  state!: CloudPanelState;

  private command(command: CloudCommand): void {
    this.dispatchEvent(
      new CustomEvent<CloudCommand>("cloud-command", {
        detail: command,
        bubbles: true,
      })
    );
  }

  protected override render() {
    const s = this.state;
    if (!s) return null;
    return html`<section
      class="container-fluid border-bottom bg-light p-3"
      aria-label="云端工作区"
    >
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <strong>云端工作区</strong>
        <span role="status"
          >${s.phase === "editor" ? (s.dirty ? "有修改未上传" : `已保存到云端 · 版本 ${s.version}`) : ""}</span
        >
        ${
          s.phase === "editor"
            ? html`
                <button
                  class="btn btn-primary btn-sm"
                  ?disabled=${s.busy || s.conflict}
                  @click=${() => this.command({ type: "save" })}
                >
                  保存到云端
                </button>
                <button
                  class="btn btn-outline-primary btn-sm"
                  ?disabled=${s.busy || s.conflict || s.dirty}
                  @click=${() => this.command({ type: "publish" })}
                >
                  发布当前组班表
                </button>
                <button
                  class="btn btn-outline-secondary btn-sm"
                  ?disabled=${s.busy}
                  @click=${() => this.command({ type: "download" })}
                >
                  下载恢复副本
                </button>
                <label class="btn btn-outline-secondary btn-sm mb-0"
                  >导入恢复副本<input
                    class="visually-hidden"
                    type="file"
                    accept=".json,application/json"
                    ?disabled=${s.busy || s.conflict}
                    @change=${this.restore}
                /></label>
                ${s.canImport ? html`<button class="btn btn-outline-secondary btn-sm" ?disabled=${s.busy || s.conflict} @click=${() => this.command({ type: "import-local" })}>首次从本机迁移</button>` : null}
                <button
                  class="btn btn-outline-secondary btn-sm"
                  ?disabled=${s.busy}
                  @click=${() => this.command({ type: "logout" })}
                >
                  退出登录
                </button>
              `
            : null
        }
      </div>
      ${
        s.phase === "login"
          ? html`
              <form class="d-flex flex-wrap gap-2 mt-3" @submit=${this.login}>
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
              </form>
              <p class="small text-secondary mt-2 mb-0">
                仅管理员可修改。查看班表请打开管理员提供的发布链接。
              </p>
            `
          : null
      }
      ${s.message ? html`<p class="mt-2 mb-0" role="status">${s.message}</p>` : null}
      ${s.cacheWarning ? html`<p class="mt-2 mb-0 text-danger" role="alert">${s.cacheWarning}</p>` : null}
      ${
        s.conflict
          ? html`
              <p class="mt-2 mb-1 text-danger" role="alert">
                本机有尚未上传的旧副本，云端已有不同版本。编辑已暂停，请先下载副本备份。
              </p>
              <button
                class="btn btn-outline-danger btn-sm"
                ?disabled=${s.busy}
                @click=${() => this.command({ type: "discard" })}
              >
                放弃本机旧副本，使用云端数据
              </button>
            `
          : null
      }
      ${s.phase === "editor" ? html`<p class="small text-secondary mt-2 mb-0">编辑后请点“保存到云端”，换电脑才能接续。只有点“发布”才会更新公开班表；发布内容不含配置、草稿或历史库。</p>` : null}
      ${s.shareUrl ? html`<label class="d-block mt-2">查看链接<input class="form-control" readonly .value=${s.shareUrl} @focus=${(event: FocusEvent) => (event.target as HTMLInputElement).select()} /></label>` : null}
      ${
        s.phase === "error"
          ? html`
              <button
                class="btn btn-outline-primary btn-sm mt-2"
                ?disabled=${s.busy}
                @click=${() => this.command({ type: "retry" })}
              >
                重新连接
              </button>
              <button
                class="btn btn-outline-secondary btn-sm mt-2"
                ?disabled=${s.busy}
                @click=${() => this.command({ type: "logout" })}
              >
                退出当前登录
              </button>
            `
          : null
      }
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

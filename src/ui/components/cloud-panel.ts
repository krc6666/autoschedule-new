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
                登录后可读取和保存云端配置。
              </p>
            `
          : null
      }
      ${s.message ? html`<p class="mt-2 mb-0" role="status">${s.message}</p>` : null}
      ${
        s.conflict
          ? html`
              <p class="mt-2 mb-1 text-danger" role="alert">
                当前设备还有未保存到云端的内容，但云端已有不同版本。编辑已暂停，请核对后再选择使用云端内容。
              </p>
              <button
                class="btn btn-outline-danger btn-sm"
                ?disabled=${s.busy}
                @click=${() => this.command({ type: "discard" })}
              >
                放弃本机未保存修改，使用云端内容
              </button>
            `
          : null
      }
      ${s.phase === "editor" ? html`<p class="small text-secondary mt-2 mb-0">修改后请点“保存到云端”，保存成功后再退出。</p>` : null}
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
}

customElements.define("autoschedule-cloud-panel", CloudPanelElement);

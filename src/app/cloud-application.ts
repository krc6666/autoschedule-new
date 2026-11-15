import { mountAutoscheduleApp, type MountedAutoscheduleApp } from "../app";
import type { CloudBackend } from "./cloud-contract";
import { CloudWorkspace } from "./cloud-workspace";
import {
  createBrowserCloudPersistence,
  readCloudRecoveryFile,
  type BrowserCloudPersistence,
} from "../infrastructure/cloud-recovery-store";
import { downloadBlob } from "../utils";
import {
  CloudPanelElement,
  type CloudCommand,
  type CloudPanelState,
} from "../ui/components/cloud-panel";
import { PublicScheduleElement } from "../ui/components/public-schedule";

const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CloudApplicationOptions {
  persistence?: (scope: string, userId: string) => BrowserCloudPersistence;
  location?: Pick<Location, "href" | "hash">;
  confirm?: (message: string) => boolean;
  mountEditor?: typeof mountAutoscheduleApp;
  download?: (json: string) => void;
}

export function mountCloudApplication(
  root: HTMLElement,
  backend: CloudBackend,
  scope: string,
  options: CloudApplicationOptions = {}
): { dispose(): void } {
  const location = options.location ?? window.location;
  const token = new URLSearchParams(location.hash.slice(1)).get("schedule");
  let disposed = false;
  if (token !== null) {
    const view = new PublicScheduleElement();
    root.replaceChildren(view);
    if (!TOKEN_PATTERN.test(token))
      view.message = "查看链接不完整，请向管理员索取有效链接。";
    else
      void backend
        .readPublication(token)
        .then((schedule) => {
          if (disposed) return;
          view.schedule = schedule;
          if (!schedule) view.message = "未找到已发布班表，请核对查看链接。";
        })
        .catch(() => {
          if (!disposed)
            view.message = "班表暂时无法读取，请检查网络或稍后刷新。";
        });
    return {
      dispose: () => {
        disposed = true;
        view.remove();
      },
    };
  }

  const panel = new CloudPanelElement();
  const editorRoot = document.createElement("div");
  root.replaceChildren(panel, editorRoot);
  let workspace: CloudWorkspace | null = null;
  let editor: MountedAutoscheduleApp | null = null;
  let epoch = 0;
  let actionPending = false;
  let persistence: BrowserCloudPersistence | null = null;
  let state: CloudPanelState = {
    phase: "loading",
    busy: true,
    message: "正在验证登录与读取云端数据…",
    dirty: false,
    version: 0,
    conflict: false,
    canImport: false,
    cacheWarning: "",
    shareUrl: "",
  };
  const render = (patch: Partial<CloudPanelState> = {}) => {
    if (disposed) return;
    state = { ...state, ...patch };
    if (workspace)
      state = {
        ...state,
        dirty: workspace.hasUnsavedChanges,
        version: workspace.cloudVersion,
        conflict: workspace.recoveryConflict,
        cacheWarning: workspace.cacheWarning,
        canImport: workspace.cloudVersion === 0,
      };
    editorRoot.inert = state.busy || state.conflict;
    editorRoot.hidden = state.conflict;
    panel.state = state;
  };
  const closeEditor = () => {
    editor?.dispose();
    workspace?.dispose();
    editor = null;
    workspace = null;
    editorRoot.replaceChildren();
  };
  const connect = async () => {
    const request = ++epoch;
    closeEditor();
    render({
      phase: "loading",
      busy: true,
      message: "正在验证登录与读取云端数据…",
      shareUrl: "",
    });
    try {
      const userId = await backend.currentUser();
      if (disposed || request !== epoch) return;
      if (!userId) {
        render({
          phase: "login",
          busy: false,
          message: "",
          dirty: false,
          conflict: false,
          cacheWarning: "",
        });
        return;
      }
      const remote = await backend.load();
      if (disposed || request !== epoch) return;
      persistence = (options.persistence ?? createBrowserCloudPersistence)(
        scope,
        userId
      );
      workspace = new CloudWorkspace(backend, remote, persistence.recovery);
      const current = workspace;
      current.onChange = () => render();
      editor = (options.mountEditor ?? mountAutoscheduleApp)(editorRoot, {
        store: current.store,
        cloud: true,
        preferences: persistence.preferences,
        shouldWarnOnExit: () => current.hasUnsavedChanges,
      });
      render({
        phase: "editor",
        busy: false,
        message:
          remote.version === 0
            ? "云端还没有数据。可首次迁移本机资料，或在工作台配置后保存到云端。"
            : "已读取云端数据。本机未上传的同版本修改会作为恢复内容保留。",
      });
    } catch (error) {
      if (!disposed && request === epoch)
        render({
          phase: "error",
          busy: false,
          message:
            error instanceof Error
              ? error.message
              : "云端连接失败，未打开编辑页面。",
        });
    }
  };
  const confirm = options.confirm ?? globalThis.confirm;
  const download =
    options.download ??
    ((json: string) =>
      downloadBlob(
        new Blob([json], { type: "application/json" }),
        "排班云端恢复副本.json"
      ));
  const handle = async (command: CloudCommand) => {
    if (actionPending || disposed) return;
    actionPending = true;
    const actionWorkspace = workspace;
    render({ busy: true, message: "正在处理…" });
    try {
      if (command.type === "login") {
        await backend.signIn(command.email, command.password);
        await connect();
      } else if (command.type === "retry") {
        await connect();
      } else if (command.type === "logout" && !workspace) {
        await backend.signOut();
        await connect();
      } else if (workspace) {
        if (!editor?.canTransferWorkspace())
          throw new Error(
            "请先结束排班计算，或保存/取消历史编辑，再进行云端操作。"
          );
        if (command.type === "download") {
          download(workspace.recoveryJson());
          render({
            message:
              "已生成恢复副本，请妥善保管；此文件包含内部配置与历史，不是公开班表。",
          });
        } else {
          switch (command.type) {
            case "save":
              await workspace.save();
              if (workspace !== actionWorkspace) return;
              render({ message: "已保存到云端。公开班表仍需单独发布。" });
              break;
            case "publish": {
              const publication = await workspace.publish();
              if (workspace !== actionWorkspace) return;
              const url = new URL(location.href);
              url.hash = `schedule=${publication.token}`;
              render({
                shareUrl: url.href,
                message: `已发布 ${publication.snapshot.groupId} 组 ${publication.snapshot.date} 班表。`,
              });
              break;
            }
            case "import-local":
              if (
                confirm(
                  "只把当前浏览器的完整两组资料带入编辑区，不立即上传。确认后请核对并点击保存到云端；原本地资料保留。"
                )
              ) {
                const local = persistence?.loadLocalModel();
                if (!local)
                  throw new Error(
                    "当前浏览器没有旧本地数据，可通过现有Excel导入入口恢复配置。"
                  );
                workspace.importLocal(local);
                render({
                  message: "本机资料已带入编辑区，请核对两组内容后保存到云端。",
                });
              }
              break;
            case "discard":
              if (
                confirm(
                  "确认已下载需要保留的恢复副本？继续会放弃本机旧副本，使用当前已读取的云端数据。"
                )
              )
                workspace.discardRecovery();
              break;
            case "restore": {
              const restored = await readCloudRecoveryFile(command.file);
              if (workspace !== actionWorkspace) return;
              if (
                confirm(
                  "用此恢复副本替换当前编辑区的两组资料？不会立即改写云端，确认后请核对并重新保存。"
                )
              ) {
                workspace.restoreRecovery(restored);
                render({
                  message:
                    "恢复副本已带入编辑区，尚未上传；核对后请保存到云端。",
                });
              }
              break;
            }
            case "logout":
              if (
                workspace.hasUnsavedChanges &&
                !confirm(
                  "还有修改未上传。退出前将保留本机恢复副本，换电脑仍无法读取这些修改。确认退出？"
                )
              )
                break;
              if (!workspace.recoveryConflict) workspace.stash();
              await backend.signOut();
              ++epoch;
              closeEditor();
              render({
                phase: "login",
                dirty: false,
                conflict: false,
                canImport: false,
                cacheWarning: "",
                shareUrl: "",
                message: "已退出当前设备。",
              });
              break;
          }
        }
      }
    } catch (error) {
      if (!actionWorkspace || workspace === actionWorkspace)
        render({
          message:
            error instanceof Error ? error.message : "操作未成功，请重试。",
        });
    } finally {
      actionPending = false;
      render({ busy: false });
    }
  };
  const listener = (event: Event) => {
    void handle((event as CustomEvent<CloudCommand>).detail);
  };
  panel.addEventListener("cloud-command", listener);
  const unsubscribeAuth = backend.onSignedOut(() => {
    // Never await another Auth operation inside Supabase's synchronous callback.
    queueMicrotask(() => {
      if (disposed) return;
      ++epoch;
      try {
        if (
          workspace &&
          !workspace.recoveryConflict &&
          editor?.canTransferWorkspace()
        )
          workspace.stash();
      } catch {
        /* Existing committed recovery copy remains. */
      }
      closeEditor();
      render({
        phase: "login",
        busy: false,
        dirty: false,
        conflict: false,
        canImport: false,
        cacheWarning: "",
        shareUrl: "",
        message: "登录已结束，请重新登录。",
      });
    });
  });
  render();
  void connect();
  return {
    dispose: () => {
      ++epoch;
      try {
        if (
          workspace &&
          !workspace.recoveryConflict &&
          editor?.canTransferWorkspace()
        )
          workspace.stash();
      } catch {
        /* Exit warning also protects unsaved editor changes. */
      }
      disposed = true;
      unsubscribeAuth();
      panel.removeEventListener("cloud-command", listener);
      closeEditor();
      panel.remove();
    },
  };
}

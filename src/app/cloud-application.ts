import { mountAutoscheduleApp, type MountedAutoscheduleApp } from "../app";
import { CloudError, type CloudBackend } from "./cloud-contract";
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
import { OperationAuditController } from "./operation-audit-controller";
import {
  OperationAuditPageElement,
  type AuditPageCommand,
} from "../ui/components/operation-audit-page";

const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CloudApplicationOptions {
  persistence?: (scope: string, userId: string) => BrowserCloudPersistence;
  location?: Pick<Location, "href" | "hash">;
  confirm?: (message: string) => boolean;
  alert?: (message: string) => void;
  mountEditor?: typeof mountAutoscheduleApp;
  download?: (json: string) => void;
  now?: () => number;
}

export function mountCloudApplication(
  root: HTMLElement,
  backend: CloudBackend,
  scope: string,
  options: CloudApplicationOptions = {}
): { dispose(): void } {
  const location = options.location ?? window.location;
  const now = options.now ?? Date.now;
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
  const auditRoot = document.createElement("div");
  auditRoot.hidden = true;
  root.replaceChildren(panel, editorRoot, auditRoot);
  let audit: OperationAuditController | null = null;
  let workspace: CloudWorkspace | null = null;
  let editor: MountedAutoscheduleApp | null = null;
  let epoch = 0;
  let pendingCommand: CloudCommand["type"] | null = null;
  let persistence: BrowserCloudPersistence | null = null;
  let state: CloudPanelState = {
    phase: "loading",
    busy: true,
    message: "正在验证登录与读取云端数据…",
    notice: null,
    saveFeedback: { phase: "idle" },
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
        dirty:
          workspace.hasUnsavedChanges || Boolean(editor?.hasUnsavedRules()),
        version: workspace.cloudVersion,
        conflict: workspace.recoveryConflict,
        cacheWarning: workspace.cacheWarning,
        canImport: workspace.cloudVersion === 0,
      };
    editorRoot.inert = state.busy || state.conflict;
    editorRoot.hidden = state.conflict || Boolean(state.auditOpen);
    auditRoot.hidden = state.phase !== "editor" || !state.auditOpen;
    panel.state = state;
  };
  const closeEditor = () => {
    audit?.dispose();
    audit = null;
    auditRoot.replaceChildren();
    state = { ...state, auditOpen: false };
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
      notice: null,
      saveFeedback: { phase: "idle" },
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
        onRulesChange: () => render(),
        shouldWarnOnExit: () =>
          current.hasUnsavedChanges || pendingCommand === "save",
      });
      render({
        phase: "editor",
        busy: false,
        message: "",
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
  const alert = options.alert ?? ((message: string) => window.alert(message));
  const download =
    options.download ??
    ((json: string) =>
      downloadBlob(
        new Blob([json], { type: "application/json" }),
        "排班云端恢复副本.json"
      ));
  const handle = async (command: CloudCommand) => {
    if (pendingCommand !== null || disposed) return;
    if (command.type === "audit" || command.type === "workspace") {
      if (!workspace || state.phase !== "editor") return;
      if (command.type === "workspace") {
        render({ auditOpen: false });
      } else {
        if (editor && !editor.confirmLeaveRules(confirm)) return;
        if (!audit) {
          audit = new OperationAuditController(backend);
          const page = new OperationAuditPageElement();
          page.view = audit.view;
          const currentAudit = audit;
          audit.onChange = (view) => {
            page.view = view;
          };
          page.addEventListener("audit-command", (event) => {
            if (disposed || currentAudit !== audit) return;
            const action = (event as CustomEvent<AuditPageCommand>).detail;
            if (action.type === "back") void handle({ type: "workspace" });
            else if (action.type === "refresh" || action.type === "more")
              void currentAudit.load(action.type === "more");
            else if ("id" in action)
              void currentAudit.expand(
                action.id,
                action.type === "details-more"
              );
          });
          auditRoot.replaceChildren(page);
        }
        render({ auditOpen: true });
        await audit.load();
      }
      return;
    }
    pendingCommand = command.type;
    const actionWorkspace = workspace;
    render({
      busy: true,
      message: "",
      notice: null,
      ...(command.type === "save"
        ? { saveFeedback: { phase: "saving" as const } }
        : {}),
    });
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
        if (
          editor.hasUnsavedRules() &&
          (command.type === "save" ||
            command.type === "publish" ||
            command.type === "download")
        )
          throw new Error(
            "规则有未保存的修改，请返回规则页点击“保存规则”，再进行云端保存、发布或下载。"
          );
        if (command.type === "download") {
          download(workspace.recoveryJson());
          render({
            message: "恢复副本已下载。",
            notice: "info",
          });
        } else {
          switch (command.type) {
            case "save":
              await workspace.save();
              if (workspace !== actionWorkspace) return;
              render({ saveFeedback: { phase: "saved", savedAt: now() } });
              break;
            case "publish": {
              const publication = await workspace.publish();
              if (workspace !== actionWorkspace) return;
              const url = new URL(location.href);
              url.hash = `schedule=${publication.token}`;
              render({
                shareUrl: url.href,
                message: `已发布 ${publication.snapshot.groupId} 组 ${publication.snapshot.date} 班表。`,
                notice: "info",
              });
              break;
            }
            case "import-local":
              if (
                confirm(
                  "只把当前浏览器的完整两组资料带入编辑区，不立即上传。确认后请核对并点击保存到云端；原本地资料保留。"
                )
              ) {
                if (!editor.confirmLeaveRules(confirm)) break;
                const local = persistence?.loadLocalModel();
                if (!local)
                  throw new Error(
                    "当前浏览器没有旧本地数据，可通过现有Excel导入入口恢复配置。"
                  );
                workspace.importLocal(local);
                render({
                  message: "已导入，尚未保存到云端。",
                  notice: "info",
                  saveFeedback: { phase: "idle" },
                });
              }
              break;
            case "discard":
              if (
                confirm(
                  "放弃当前设备尚未保存到云端的修改，改用已保存的云端内容？此操作不会改写云端。"
                )
              ) {
                if (!editor.confirmLeaveRules(confirm)) break;
                workspace.discardRecovery();
                render({ saveFeedback: { phase: "idle" } });
              }
              break;
            case "restore": {
              const restored = await readCloudRecoveryFile(command.file);
              if (workspace !== actionWorkspace) return;
              if (
                confirm(
                  "用此恢复副本替换当前编辑区的两组资料？不会立即改写云端，确认后请核对并重新保存。"
                )
              ) {
                if (!editor.confirmLeaveRules(confirm)) break;
                workspace.restoreRecovery(restored);
                render({
                  message: "已导入，尚未保存到云端。",
                  notice: "info",
                  saveFeedback: { phase: "idle" },
                });
              }
              break;
            }
            case "logout":
              if (
                workspace.hasUnsavedChanges &&
                !confirm(
                  "还有修改未保存到云端。\n请点“取消”，回到工作台点击“保存到云端”，保存成功后再退出。\n点“确定”将直接退出，未保存的修改无法从云端读取。确定仍要退出？"
                )
              ) {
                render({
                  message:
                    "已取消退出，请先点击“保存到云端”，保存成功后再退出。",
                  notice: "info",
                });
                break;
              }
              if (!editor.confirmLeaveRules(confirm)) break;
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
                saveFeedback: { phase: "idle" },
              });
              break;
          }
        }
      }
    } catch (error) {
      if (!disposed && (!actionWorkspace || workspace === actionWorkspace)) {
        const message =
          error instanceof Error ? error.message : "操作未成功，请重试。";
        render(
          command.type === "save"
            ? {
                message: "",
                saveFeedback: {
                  phase: "failed",
                  kind: error instanceof CloudError ? error.kind : "unknown",
                  message,
                },
              }
            : { message, notice: "error" }
        );
        if (command.type === "save")
          alert(
            `云端保存失败\n${message}\n\n尚未确认保存到云端，请不要关闭页面，核对后重新点击“保存到云端”。`
          );
      }
    } finally {
      pendingCommand = null;
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
        notice: null,
        saveFeedback: { phase: "idle" },
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

import { ApplicationCoordinator } from "./app/application-coordinator";
import { createAutoscheduleStore } from "./app/store/autoschedule-store";
import type { AutoscheduleAppElement } from "./ui/components/autoschedule-app";
import "./ui/components/autoschedule-app";
import { createBrowserPreferences } from "./infrastructure/browser-preferences";
import { installGlobalErrorBoundary } from "./infrastructure/global-error-boundary";
import { getLastRestorationReport } from "./infrastructure/state-restoration";
import { browserStatePersistence } from "./infrastructure/storage";
import { createBrowserScheduleRunController } from "./app/schedule-run-controller";
import { installBrowserExitWarning } from "./app/browser-exit-warning";
import type { AutoscheduleStore } from "./app/store/autoschedule-store";
import type { ApplicationPreferences } from "./app/application-preferences";

export interface MountedAutoscheduleApp {
  dispose(): void;
  canTransferWorkspace(): boolean;
  hasUnsavedRules(): boolean;
  confirmLeaveRules(confirm?: (message: string) => boolean): boolean;
}

export function mountAutoscheduleApp(
  root: HTMLElement,
  options: {
    store?: AutoscheduleStore;
    cloud?: boolean;
    preferences?: ApplicationPreferences;
    shouldWarnOnExit?: () => boolean;
    onRulesChange?: () => void;
  } = {}
): MountedAutoscheduleApp {
  const errorBoundary = installGlobalErrorBoundary(root);
  const store =
    options.store ??
    createAutoscheduleStore({
      persistence: browserStatePersistence,
    });
  const restoredModel = store.getState().model;
  const restoredScheduleNotice =
    restoredModel.assignments.length > 0 && restoredModel.schedulePolicyStale;
  const restorationIssues = getLastRestorationReport().issues;
  const element: AutoscheduleAppElement =
    document.createElement("autoschedule-app");
  const coordinator = new ApplicationCoordinator(
    store,
    {
      preferences: options.preferences ?? createBrowserPreferences(),
      restoredScheduleNotice,
      onViewChange: (view) => {
        element.view = view;
        options.onRulesChange?.();
      },
    },
    {
      createScheduleRunner: createBrowserScheduleRunController,
    }
  );
  element.commandHandler = coordinator;
  const removeBrowserExitWarning = installBrowserExitWarning(
    window,
    () =>
      coordinator.hasUnsavedRules() ||
      (options.shouldWarnOnExit?.() ?? store.getState().hasUnexportedChanges())
  );
  element.cloud = options.cloud ?? false;
  element.model = store.getState().model;
  const unsubscribe = store.subscribe((state) => {
    element.model = state.model;
    element.view = coordinator.view();
  });
  root.replaceChildren(element);
  coordinator.start();
  if (restorationIssues.length) {
    coordinator.toast(
      `部分旧数据未恢复（${restorationIssues.length} 项），请重新排班或检查控制台日志。`,
      "warning"
    );
  }
  return {
    canTransferWorkspace: () => coordinator.canTransferWorkspace(),
    hasUnsavedRules: () => coordinator.hasUnsavedRules(),
    confirmLeaveRules: (confirm) => coordinator.confirmLeaveRules(confirm),
    dispose: () => {
      coordinator.scheduleRunner.stopWithoutResult();
      removeBrowserExitWarning();
      unsubscribe();
      element.remove();
      errorBoundary.dispose();
    },
  };
}

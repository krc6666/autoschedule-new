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

export interface MountedAutoscheduleApp {
  dispose(): void;
}

export function mountAutoscheduleApp(
  root: HTMLElement
): MountedAutoscheduleApp {
  const errorBoundary = installGlobalErrorBoundary(root);
  const store = createAutoscheduleStore({
    persistence: browserStatePersistence,
  });
  const removeBrowserExitWarning = installBrowserExitWarning(window, () =>
    store.getState().hasUnexportedChanges()
  );
  const restoredScheduleNotice = store.getState().model.assignments.length > 0;
  const restorationIssues = getLastRestorationReport().issues;
  const element: AutoscheduleAppElement =
    document.createElement("autoschedule-app");
  const coordinator = new ApplicationCoordinator(
    store,
    {
      preferences: createBrowserPreferences(),
      restoredScheduleNotice,
      onViewChange: (view) => {
        element.view = view;
      },
    },
    {
      createScheduleRunner: createBrowserScheduleRunController,
    }
  );
  element.commandHandler = coordinator;
  element.model = store.getState().model;
  const unsubscribe = store.subscribe((state) => {
    element.model = state.model;
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
    dispose: () => {
      removeBrowserExitWarning();
      unsubscribe();
      element.remove();
      errorBoundary.dispose();
    },
  };
}

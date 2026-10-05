type BrowserExitTarget = {
  addEventListener(
    type: "beforeunload",
    listener: (event: BeforeUnloadEvent) => void
  ): void;
  removeEventListener(
    type: "beforeunload",
    listener: (event: BeforeUnloadEvent) => void
  ): void;
};

export function installBrowserExitWarning(
  target: BrowserExitTarget,
  shouldWarn: () => boolean
): () => void {
  const listener = (event: BeforeUnloadEvent): void => {
    if (!shouldWarn()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  target.addEventListener("beforeunload", listener);
  return () => target.removeEventListener("beforeunload", listener);
}

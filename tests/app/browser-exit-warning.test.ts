import { describe, expect, it, vi } from "vitest";

import { installBrowserExitWarning } from "../../src/app/browser-exit-warning";

describe("browser exit warning", () => {
  it("asks the browser to warn when unexported changes exist", () => {
    let listener: ((event: BeforeUnloadEvent) => void) | undefined;
    const target = {
      addEventListener: vi.fn((_type: string, callback: EventListener) => {
        listener = callback as (event: BeforeUnloadEvent) => void;
      }),
      removeEventListener: vi.fn(),
    };
    const event = {
      preventDefault: vi.fn(),
      returnValue: undefined,
    } as unknown as BeforeUnloadEvent;

    const dispose = installBrowserExitWarning(target, () => true);
    listener?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe("");

    dispose();
    expect(target.removeEventListener).toHaveBeenCalledOnce();
  });

  it("does nothing when there are no unexported changes", () => {
    let listener: ((event: BeforeUnloadEvent) => void) | undefined;
    const target = {
      addEventListener: vi.fn((_type: string, callback: EventListener) => {
        listener = callback as (event: BeforeUnloadEvent) => void;
      }),
      removeEventListener: vi.fn(),
    };
    const event = {
      preventDefault: vi.fn(),
      returnValue: undefined,
    } as unknown as BeforeUnloadEvent;

    installBrowserExitWarning(target, () => false);
    listener?.(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.returnValue).toBeUndefined();
  });
});

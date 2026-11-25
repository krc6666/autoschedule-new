import { describe, expect, it } from "vitest";

import { createBrowserPreferences } from "../../src/infrastructure/browser-preferences";

describe("browser display preferences", () => {
  it("saves table zoom and cell size under separate preferences", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const preferences = createBrowserPreferences(storage);

    preferences.saveScheduleZoom(1.4);
    preferences.saveScheduleCellSize?.(0.9);

    expect(preferences.loadScheduleZoom()).toBe(1.4);
    expect(preferences.loadScheduleCellSize?.()).toBe(0.9);
  });
});

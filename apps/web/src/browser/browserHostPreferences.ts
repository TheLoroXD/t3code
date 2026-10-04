import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { EnvironmentId, PreviewBrowserHost } from "@t3tools/contracts";
import { isElectron } from "~/env";

export interface BrowserHostPreference {
  readonly host: PreviewBrowserHost;
  readonly profileId?: string | undefined;
}

export const useBrowserHostPreferences = create<{
  readonly byEnvironment: Record<string, BrowserHostPreference>;
  readonly set: (environmentId: EnvironmentId, choice: BrowserHostPreference) => void;
}>()(
  persist(
    (set) => ({
      byEnvironment: {},
      set: (environmentId, choice) =>
        set((state) => ({ byEnvironment: { ...state.byEnvironment, [environmentId]: choice } })),
    }),
    { name: "t3:browser-host-preferences" },
  ),
);

export const browserHostPreference = (environmentId: EnvironmentId): BrowserHostPreference =>
  useBrowserHostPreferences.getState().byEnvironment[environmentId] ?? {
    host: isElectron ? "client" : "environment",
  };

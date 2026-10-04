import { AsyncResult } from "effect/unstable/reactivity";
import { chooseBrowserHost } from "./BrowserOpenDialog";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

/** Creates a new browser tab. Reopening an existing tab is a separate UI action. */
export async function addBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  /** Omit to use the configured default profile. */
  readonly profileId?: string | undefined;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const choice = await chooseBrowserHost(input.threadRef, input.profileId);
  if (!choice) return AsyncResult.success(undefined);
  const result = await openPreviewSession({
    host: choice.host,
    profileId: choice.profileId,
    openPreview: input.openPreview,
    threadRef: input.threadRef,
  });
  return mapAtomCommandResult(result, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

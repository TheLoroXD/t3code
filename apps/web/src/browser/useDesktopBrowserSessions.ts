import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { isElectron } from "~/env";
import { applyPreviewServerEvent, resetPreviewServerEpoch } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";

const inactiveAtom = Atom.make(() => undefined);
const desktopBrowserSessionsAtom = Atom.family((environmentId: EnvironmentId) => {
  const eventsAtom = previewEnvironment.events({ environmentId, input: {} });
  return Atom.make((get) => {
    let serverEpoch: string | null = null;
    get.subscribe(
      eventsAtom,
      (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        const event = result.value;
        if (serverEpoch !== event.serverEpoch) {
          for (const threadRef of resetPreviewServerEpoch(environmentId, event.serverEpoch)) {
            get.refresh(
              previewEnvironment.list({ environmentId, input: { threadId: threadRef.threadId } }),
            );
          }
          serverEpoch = event.serverEpoch;
        }
        applyPreviewServerEvent(
          scopeThreadRef(environmentId, ThreadId.make(event.threadId)),
          event,
        );
      },
      { immediate: true },
    );
  }).pipe(Atom.withLabel(`preview:desktop-host-sync:${environmentId}`));
});

/** The desktop hosts its server's tabs even while their chat views are unmounted. */
export function useDesktopBrowserSessions(environmentId: EnvironmentId | null): void {
  useAtomValue(
    isElectron && environmentId !== null ? desktopBrowserSessionsAtom(environmentId) : inactiveAtom,
  );
}

import { EnvironmentId, ThreadId, type PreviewListResult } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { appAtomRegistry, AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { usePreviewSession } from "./usePreviewSession";

const calls = vi.hoisted(() => ({ list: vi.fn(), events: vi.fn() }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    list: (input: unknown) => {
      calls.list(input);
      return listAtom;
    },
    events: (input: unknown) => {
      calls.events(input);
      return eventsAtom;
    },
  },
}));

const ref = {
  environmentId: EnvironmentId.make("reconnect-host"),
  threadId: ThreadId.make("reconnect-thread"),
};
const listAtom = Atom.make<AsyncResult.AsyncResult<PreviewListResult>>(AsyncResult.initial(false));
const eventsAtom = Atom.make(AsyncResult.initial(false));
const session = {
  threadId: ref.threadId,
  tabId: "persistent-linux-tab",
  host: "environment" as const,
  profileId: "personal",
  navStatus: {
    _tag: "Success" as const,
    url: "http://127.0.0.1:13991/",
    title: "Completed on Linux",
  },
  canGoBack: false,
  canGoForward: false,
  viewport: { _tag: "fill" as const },
  updatedAt: "2026-10-04T03:56:20.000Z",
};
let renderer: ReactTestRenderer | undefined;

function Thread({ connected = true }: { connected?: boolean }) {
  usePreviewSession(connected ? ref : null);
  return null;
}
async function mount(connected = true) {
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <Thread connected={connected} />
      </AppAtomRegistryProvider>,
    );
  });
}
const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
  appAtomRegistry.set(listAtom, AsyncResult.initial(false));
  appAtomRegistry.set(eventsAtom, AsyncResult.initial(false));
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  resetPreviewStateForTests();
  vi.unstubAllGlobals();
});

describe("thread browser reconnect", () => {
  it("keeps a saved surface while the host is loading, then restores its live tab without a browser view", async () => {
    useRightPanelStore.getState().openBrowser(ref, session.tabId);
    await mount();
    expect(panel().activeSurfaceId).toBe(`browser:${session.tabId}`);
    expect(readThreadPreviewState(ref).serverEpoch).toBeNull();
    await act(() => {
      appAtomRegistry.set(
        listAtom,
        AsyncResult.success({ serverEpoch: "linux-process", revision: 1, sessions: [session] }),
      );
    });
    expect(readThreadPreviewState(ref).sessions[session.tabId]).toEqual(session);
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: `browser:${session.tabId}` });
    expect(panel().surfaces).toHaveLength(1);
  });

  it("removes a stale browser surface only after an authoritative empty list arrives", async () => {
    useRightPanelStore.getState().openBrowser(ref, session.tabId);
    await mount();
    expect(panel().surfaces).toHaveLength(1);
    await act(() => {
      appAtomRegistry.set(
        listAtom,
        AsyncResult.success({ serverEpoch: "linux-process", revision: 2, sessions: [] }),
      );
    });
    expect(panel().surfaces).toHaveLength(0);
  });

  it("does not subscribe to a host from a draft or absent thread", async () => {
    await mount(false);
    expect(calls.list).not.toHaveBeenCalled();
    expect(calls.events).not.toHaveBeenCalled();
  });
});

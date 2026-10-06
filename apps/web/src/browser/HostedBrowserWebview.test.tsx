import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  activeRecordings: new Set<string>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: mocks }),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
    setColorScheme: async () => undefined,
    setZoomFactor: async () => undefined,
  },
}));

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make("desktop-primary") };
});
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    events: ({ environmentId }: { environmentId: string }) => previewEventsFor(environmentId),
    list: () => previewList,
  },
}));

vi.mock("~/components/preview/usePreviewBridge", () => ({
  usePreviewBridge: () => undefined,
}));

vi.mock("./browserRecording", () => ({
  useActiveBrowserRecordingTabIds: () => mocks.activeRecordings,
  stopBrowserRecording: async () => null,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";

const previewEvents = new Map<
  string,
  Atom.Writable<AsyncResult.AsyncResult<PreviewEvent>, AsyncResult.AsyncResult<PreviewEvent>>
>();
const previewList = Atom.make(AsyncResult.initial());
function previewEventsFor(environmentId: string) {
  let atom = previewEvents.get(environmentId);
  if (!atom) {
    atom = Atom.make<AsyncResult.AsyncResult<PreviewEvent>>(AsyncResult.initial());
    previewEvents.set(environmentId, atom);
  }
  return atom;
}

let renderer: ReactTestRenderer | undefined;

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetPreviewStateForTests();
  for (const atom of previewEvents.values()) appAtomRegistry.set(atom, AsyncResult.initial());
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  mocks.getClientSettings.mockReset();
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("document", { documentElement: {}, head: {} });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("Electron browser hosting outside the selected thread", () => {
  it("attaches a primary-server tab without a chat view and releases it when closed", async () => {
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      renderer = create(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? Object.assign(new EventTarget(), { getWebContentsId: () => 42 })
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });
    const threadRef = {
      environmentId: EnvironmentId.make("desktop-primary"),
      threadId: ThreadId.make("background-agent"),
    };
    const opened: PreviewEvent = {
      type: "opened",
      threadId: threadRef.threadId,
      tabId: "background-tab",
      serverEpoch: "primary-server",
      revision: 1,
      createdAt: "2026-10-06T00:00:00.000Z",
      snapshot: {
        threadId: threadRef.threadId,
        tabId: "background-tab",
        runtime: "server",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-06T00:00:00.000Z",
      },
    };
    await act(() => {
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success(opened, { waiting: true }),
      );
    });
    const runtimeTabId = previewRuntimeTabId(threadRef, opened.serverEpoch, opened.tabId);
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: DEFAULT_CLIENT_SETTINGS.browserDefaultZoomFactor,
      colorScheme: DEFAULT_CLIENT_SETTINGS.browserDefaultAppearance,
      serverTab: { threadId: threadRef.threadId, tabId: opened.tabId },
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 42);

    // Separate threads can open tabs before React paints again. The stream
    // subscriber must retain both, and must not subscribe to remote environments.
    await act(() => {
      for (const suffix of ["b", "c"]) {
        const threadId = `background-${suffix}`;
        const tabId = `tab-${suffix}`;
        appAtomRegistry.set(
          previewEventsFor(threadRef.environmentId),
          AsyncResult.success(
            {
              ...opened,
              threadId,
              tabId,
              revision: suffix === "b" ? 2 : 3,
              snapshot: { ...opened.snapshot, threadId, tabId },
            },
            { waiting: true },
          ),
        );
      }
      appAtomRegistry.set(previewEventsFor("remote-server"), AsyncResult.success(opened));
    });
    expect(mocks.createTab).toHaveBeenCalledTimes(3);
    expect(mocks.registerWebview).toHaveBeenCalledTimes(3);

    vi.useFakeTimers();
    await act(() => {
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success({ ...opened, type: "closed", revision: 4 }, { waiting: true }),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId);

    await act(() => {
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success(
          {
            ...opened,
            serverEpoch: "restarted-primary-server",
            revision: 1,
          },
          { waiting: true },
        ),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).toHaveBeenCalledTimes(3);
    for (const suffix of ["b", "c"]) {
      expect(mocks.closeTab).toHaveBeenCalledWith(
        previewRuntimeTabId(
          { ...threadRef, threadId: ThreadId.make(`background-${suffix}`) },
          opened.serverEpoch,
          `tab-${suffix}`,
        ),
      );
    }
    expect(mocks.createTab).toHaveBeenLastCalledWith(
      previewRuntimeTabId(threadRef, "restarted-primary-server", opened.tabId),
      expect.objectContaining({ serverTab: { threadId: threadRef.threadId, tabId: opened.tabId } }),
    );
    expect(mocks.registerWebview).toHaveBeenCalledTimes(4);
  });
});

afterEach(async () => {
  vi.useFakeTimers();
  await act(() => renderer?.unmount());
  renderer = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HostedBrowserWebview settings hydration", () => {
  it("starts a retained background tab only after a settings read succeeds on retry", async () => {
    const firstRead = deferred<ClientSettings | null>();
    const retryRead = deferred<ClientSettings | null>();
    const tabCreation = deferred<void>();
    mocks.getClientSettings
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    mocks.createTab.mockReturnValueOnce(tabCreation.promise);
    const acquire = vi.spyOn(desktopTabLifetime, "acquireDesktopTab");
    const createGuest = vi.fn((_attributes: unknown) =>
      Object.assign(new EventTarget(), { getWebContentsId: () => 41 }),
    );
    const threadRef = {
      environmentId: EnvironmentId.make("host-settings-retry"),
      threadId: ThreadId.make("thread-settings-retry"),
    };
    const runtimeTabId = "retained-background-tab";
    useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);

    await act(() => {
      renderer = create(
        <HostedBrowserWebview
          threadRef={threadRef}
          tabId="server-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId="work"
          zoomFactor={1.25}
        />,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? createGuest(element.props)
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });

    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    const failure = new Error("Saved settings are unavailable");
    await act(async () => {
      const hydration = ensureClientSettingsHydrated();
      firstRead.reject(failure);
      await expect(hydration).rejects.toBe(failure);
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    let retry!: Promise<void>;
    await act(() => {
      retry = ensureClientSettingsHydrated();
    });
    expect(mocks.getClientSettings).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    await act(async () => {
      retryRead.resolve({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultZoomFactor: 1.25,
        browserDefaultAppearance: "dark",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
        browserDefaultProfileId: "work",
      });
      await retry;
    });

    expect(acquire).toHaveBeenCalledExactlyOnceWith(runtimeTabId, undefined);
    expect(mocks.getPreviewConfig).toHaveBeenCalledExactlyOnceWith(threadRef.environmentId, "work");
    expect(createGuest).toHaveBeenCalledOnce();
    expect(createGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        partition: "persist:t3-preview-work",
        src: "https://example.com",
      }),
    );
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: 1.25,
      colorScheme: "dark",
    });
    expect(mocks.registerWebview).not.toHaveBeenCalled();

    await act(async () => {
      tabCreation.resolve();
      await tabCreation.promise;
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 41);
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});

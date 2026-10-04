import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Stream,
} from "effect";
import {
  BrowserProfile,
  PreviewRemoteBrowserError,
  PreviewSessionLookupError,
  PreviewAutomationOpenInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationResizeInput,
  PreviewAutomationClickInput,
  PreviewAutomationTypeInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationWaitForInput,
  PreviewAutomationSetColorSchemeInput,
  resolveBrowserProfiles,
  type PreviewBrowserHost,
  type PreviewError,
  type PreviewOpenInput,
  PreviewSessionSnapshot,
  type RemoteBrowserControl,
  type RemoteBrowserControlInput,
  type RemoteBrowserFrame,
  type RemoteBrowserInfo,
  type RemoteBrowserInput,
  type RemoteBrowserProfileInput,
  type RemoteBrowserTarget,
  type RemoteBrowserDownload,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import type { Page } from "playwright-core";
import type { PreviewAutomationInvokeInput } from "../mcp/PreviewAutomationBroker.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "./Manager.ts";
import { findBrowserExecutable, RemoteBrowserRuntime } from "./RemoteBrowserRuntime.ts";
import { startRemoteBrowserRecording } from "./RemoteBrowserRecording.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createAttachmentId, createPendingAttachmentId } from "../attachmentStore.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveRemoteAssetUrl } from "./RemoteBrowserUrls.ts";

const isRemoteBrowserError = Schema.is(PreviewRemoteBrowserError);
const decodeProfiles = Schema.decodeUnknownSync(Schema.Array(BrowserProfile));
const decodeTabs = Schema.decodeUnknownSync(Schema.Array(PreviewSessionSnapshot));
const decodeClick = Schema.decodeUnknownSync(PreviewAutomationClickInput);
const decodeEvaluate = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);
const decodeNavigate = Schema.decodeUnknownSync(PreviewAutomationNavigateInput);
const decodeOpen = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodePress = Schema.decodeUnknownSync(PreviewAutomationPressInput);
const decodeResize = Schema.decodeUnknownSync(PreviewAutomationResizeInput);
const decodeScroll = Schema.decodeUnknownSync(PreviewAutomationScrollInput);
const decodeSetColorScheme = Schema.decodeUnknownSync(PreviewAutomationSetColorSchemeInput);
const decodeType = Schema.decodeUnknownSync(PreviewAutomationTypeInput);
const decodeWaitFor = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);

const CONTROL_LEASE_MS = 30_000;
const READ_ONLY_OPERATIONS = new Set([
  "status",
  "snapshot",
  "waitFor",
  "recordingStart",
  "recordingStop",
]);

export class RemoteBrowser extends Context.Service<
  RemoteBrowser,
  {
    readonly info: Effect.Effect<RemoteBrowserInfo, PreviewRemoteBrowserError>;
    readonly profile: (
      input: RemoteBrowserProfileInput,
    ) => Effect.Effect<RemoteBrowserInfo, PreviewRemoteBrowserError>;
    readonly open: (input: PreviewOpenInput) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly navigate: PreviewManager.PreviewManager["Service"]["navigate"];
    readonly resize: PreviewManager.PreviewManager["Service"]["resize"];
    readonly refresh: PreviewManager.PreviewManager["Service"]["refresh"];
    readonly close: PreviewManager.PreviewManager["Service"]["close"];
    readonly control: (
      input: RemoteBrowserControlInput,
    ) => Effect.Effect<RemoteBrowserControl, PreviewError>;
    readonly input: (input: RemoteBrowserInput) => Effect.Effect<void, PreviewError>;
    readonly frames: (
      input: RemoteBrowserTarget & { readonly viewerId: string },
    ) => Stream.Stream<RemoteBrowserFrame, PreviewError>;
    readonly invoke: (
      input: PreviewAutomationInvokeInput,
    ) => Effect.Effect<Option.Option<unknown>, PreviewError>;
  }
>()("t3/preview/RemoteBrowser") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const manager = yield* PreviewManager.PreviewManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const clock = yield* Clock.Clock;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const root = path.join(config.stateDir, "remote-browser");
  const profilesPath = path.join(root, "profiles.json");
  const tabsPath = path.join(root, "tabs.json");
  const savedTabs = new Map<string, PreviewSessionSnapshot>();
  let userProfiles: ReadonlyArray<BrowserProfile> | undefined;
  let runtime: RemoteBrowserRuntime | undefined;
  const defaultHost = config.mode === "web" ? "environment" : "client";
  const preferences = new Map<string, PreviewBrowserHost>();
  const currentTabs = new Map<string, string>();
  const controls = new Map<string, { viewerId: string; expiresAt: number }>();
  const downloads = new Map<string, RemoteBrowserDownload[]>();
  const actions = new Map<string, Promise<unknown>>();

  const attempt = <A>(f: () => Promise<A>): Effect.Effect<A, PreviewRemoteBrowserError> =>
    Effect.tryPromise({
      try: f,
      catch: (cause) =>
        isRemoteBrowserError(cause)
          ? cause
          : new PreviewRemoteBrowserError({ reason: "failed", cause }),
    });

  const atomicWrite = async (file: string, value: unknown): Promise<void> => {
    await Effect.runPromise(fileSystem.makeDirectory(root, { recursive: true, mode: 0o700 }));
    const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    await Effect.runPromise(
      fileSystem.writeFileString(temporary, JSON.stringify(value), { mode: 0o600 }),
    );
    await Effect.runPromise(fileSystem.rename(temporary, file));
  };
  const profiles = async (): Promise<ReadonlyArray<BrowserProfile>> => {
    if (!userProfiles) {
      const text = await Effect.runPromise(
        fileSystem.readFileString(profilesPath).pipe(
          Effect.catchIf(
            (cause) => cause.reason._tag === "NotFound",
            () => Effect.succeed("[]"),
          ),
        ),
      );
      userProfiles = decodeProfiles(JSON.parse(text));
    }
    return resolveBrowserProfiles(userProfiles);
  };

  const info = attempt(async () => ({
    available: (await findBrowserExecutable(fileSystem, path)) !== undefined,
    hostname: NodeOS.hostname(),
    profiles: await profiles(),
    defaultProfileId: userProfiles?.[0]?.id ?? "default",
  }));

  const profile = (input: RemoteBrowserProfileInput) =>
    attempt(() =>
      serial("profiles", async () => {
        await profiles();
        if (input.id === "default" || input.id === "incognito")
          throw new PreviewRemoteBrowserError({ reason: "profile" });
        const id = input.id ?? `profile-${NodeCrypto.randomUUID()}`;
        const entries = userProfiles ?? [];
        if (!entries.some((entry) => entry.id === id) && entries.length >= 24)
          throw new PreviewRemoteBrowserError({ reason: "profile" });
        const next = [
          ...entries.filter((entry) => entry.id !== id),
          { id, name: input.name, kind: "persistent" as const },
        ];
        await atomicWrite(profilesPath, next);
        userProfiles = next;
        return Effect.runPromise(info);
      }),
    );

  const lookup = async (target: RemoteBrowserTarget): Promise<PreviewSessionSnapshot> => {
    const listed = await Effect.runPromise(manager.list({ threadId: target.threadId }));
    const snapshot = listed.sessions.find((session) => session.tabId === target.tabId);
    if (!snapshot) throw new PreviewSessionLookupError(target);
    return snapshot;
  };

  const serial = <A>(key: string, f: () => Promise<A>): Promise<A> => {
    const previous = actions.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(f);
    actions.set(key, next);
    void next
      .finally(() => {
        if (actions.get(key) === next) actions.delete(key);
      })
      .catch(() => undefined);
    return next;
  };

  const persist = (threadId: string) =>
    serial("manifest", async () => {
      for (const [id, snapshot] of savedTabs)
        if (snapshot.threadId === threadId) savedTabs.delete(id);
      const listed = await Effect.runPromise(manager.list({ threadId: threadId as ThreadId }));
      for (const snapshot of listed.sessions)
        if (snapshot.host === "environment" && snapshot.profileId !== "incognito")
          savedTabs.set(snapshot.tabId, snapshot);
      await atomicWrite(tabsPath, [...savedTabs.values()]);
    });

  // Restore metadata only. A restart must not replay a navigation, form or last input.
  const savedText = yield* fileSystem.readFileString(tabsPath).pipe(
    Effect.catchIf(
      (cause) => cause.reason._tag === "NotFound",
      () => Effect.succeed("[]"),
    ),
  );
  const restored = yield* attempt(async () => decodeTabs(JSON.parse(savedText)));
  for (const previous of restored) {
    if (previous.host !== "environment" || previous.profileId === "incognito") continue;
    const snapshot: PreviewSessionSnapshot =
      previous.navStatus._tag === "Idle"
        ? previous
        : {
            ...previous,
            canGoBack: false,
            canGoForward: false,
            navStatus: {
              _tag: "LoadFailed",
              url: previous.navStatus.url,
              title: previous.navStatus.title,
              code: -1,
              description:
                "The host browser restarted. Reload to reopen this page; previous actions will not be replayed.",
            },
          };
    savedTabs.set(snapshot.tabId, snapshot);
    preferences.set(snapshot.threadId, "environment");
    yield* manager.restore(snapshot);
  }

  const lease = (tabId: string) => {
    const current = controls.get(tabId);
    if (current && current.expiresAt <= clock.currentTimeMillisUnsafe()) {
      controls.delete(tabId);
      return undefined;
    }
    return current;
  };
  const assertAgentControl = (tabId: string) => {
    if (lease(tabId)) throw new PreviewRemoteBrowserError({ reason: "busy" });
  };

  const sync =
    (snapshot: PreviewSessionSnapshot) =>
    async (page: Page): Promise<void> => {
      if (page.isClosed()) return;
      const url = page.url();
      if (url === "about:blank") return;
      const title = (await page.title().catch(() => "")).slice(0, 512);
      const navigation = await page.context().newCDPSession(page);
      const history = await navigation
        .send("Page.getNavigationHistory")
        .finally(() => navigation.detach());
      await Effect.runPromise(
        manager.reportStatus({
          threadId: snapshot.threadId as ThreadId,
          tabId: snapshot.tabId,
          navStatus: { _tag: "Success", url, title },
          canGoBack: history.currentIndex > 0,
          canGoForward: history.currentIndex < history.entries.length - 1,
        }),
      );
      await persist(snapshot.threadId);
    };

  const browser = async (): Promise<RemoteBrowserRuntime> => {
    if (runtime) return runtime;
    const executablePath = await findBrowserExecutable(fileSystem, path);
    if (!executablePath) throw new PreviewRemoteBrowserError({ reason: "unavailable" });
    if (runtime) return runtime;
    runtime = new RemoteBrowserRuntime({
      profilesDir: path.join(root, "profiles"),
      executablePath,
      fileSystem,
      path,
      now: () => clock.currentTimeMillisUnsafe(),
      startRecording: (frame) =>
        startRemoteBrowserRecording({
          fileSystem,
          path,
          clock,
          spawner,
          platform,
          root: path.join(root, "recordings"),
          frame,
        }),
      timestamp: () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())),
      onPopup: async (parent, page) => {
        const snapshot = await Effect.runPromise(
          manager.open({
            threadId: parent.threadId as ThreadId,
            profileId: parent.profileId,
            host: "environment",
            viewport: parent.viewport,
          }),
        );
        runtime!.adopt(snapshot, page, sync(snapshot));
        await persist(snapshot.threadId);
        await sync(snapshot)(page);
      },
      onClose: async (snapshot, intentional) => {
        controls.delete(snapshot.tabId);
        if (intentional) return;
        const current = await lookup({
          threadId: snapshot.threadId as ThreadId,
          tabId: snapshot.tabId,
        });
        if (current.navStatus._tag !== "Idle")
          await Effect.runPromise(
            manager.reportStatus({
              threadId: snapshot.threadId as ThreadId,
              tabId: snapshot.tabId,
              navStatus: {
                _tag: "LoadFailed",
                url: current.navStatus.url,
                title: current.navStatus.title,
                code: -1,
                description:
                  "The host browser closed unexpectedly. Reload to reopen it; previous actions will not be replayed.",
              },
              canGoBack: false,
              canGoForward: false,
            }),
          );
        await persist(snapshot.threadId);
      },
      onDownload: (snapshot, page) =>
        page.on("download", (download) => {
          void (async () => {
            const name = path.basename(download.suggestedFilename()).slice(0, 255);
            const extension =
              path
                .extname(name)
                .slice(1)
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "")
                .slice(0, 10) || "bin";
            const attachmentId = createAttachmentId(snapshot.threadId, extension);
            if (!attachmentId) throw new PreviewRemoteBrowserError({ reason: "input" });
            await Effect.runPromise(
              fileSystem.makeDirectory(config.attachmentsDir, { recursive: true, mode: 0o700 }),
            );
            const destination = path.join(config.attachmentsDir, `${attachmentId}.${extension}`);
            await download.saveAs(destination);
            const stat = await Effect.runPromise(fileSystem.stat(destination));
            const entries = downloads.get(snapshot.tabId) ?? [];
            downloads.set(snapshot.tabId, [
              ...entries.slice(-9),
              { attachmentId, name, sizeBytes: Number(stat.size) },
            ]);
            runtime?.notifyControlChange(snapshot.tabId);
          })().catch(() => undefined);
        }),
    });
    return runtime;
  };
  yield* Effect.addFinalizer(() =>
    attempt(async () => {
      await runtime?.dispose();
    }).pipe(Effect.ignore),
  );

  const stopRecording = async (snapshot: PreviewSessionSnapshot, pending: boolean) => {
    const video = await (await browser()).stopRecording(snapshot.threadId, snapshot.tabId);
    // Chromium currently emits WebM; identify MP4 too so future releases stay usable.
    const extension = video.subarray(4, 8).toString() === "ftyp" ? "mp4" : "webm";
    const id = pending
      ? createPendingAttachmentId(extension)
      : createAttachmentId(snapshot.threadId, extension);
    if (!id || video.length === 0) throw new PreviewRemoteBrowserError({ reason: "failed" });
    await Effect.runPromise(
      fileSystem.makeDirectory(config.attachmentsDir, { recursive: true, mode: 0o700 }),
    );
    const destination = path.join(config.attachmentsDir, `${id}.${extension}`);
    await Effect.runPromise(fileSystem.writeFile(destination, video, { mode: 0o600 }));
    if (!pending) {
      downloads.set(snapshot.tabId, [
        ...(downloads.get(snapshot.tabId) ?? []).slice(-9),
        { attachmentId: id, name: `browser-recording.${extension}`, sizeBytes: video.length },
      ]);
      runtime?.notifyControlChange(snapshot.tabId);
    }
    return {
      id,
      tabId: snapshot.tabId,
      path: destination,
      mimeType: `video/${extension}`,
      sizeBytes: video.length,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())),
      ...(pending ? { uploadedAttachmentId: id } : {}),
    };
  };

  const open: RemoteBrowser["Service"]["open"] = Effect.fn("RemoteBrowser.open")(function* (input) {
    const host = input.host ?? preferences.get(input.threadId) ?? defaultHost;
    if (host === "client") {
      const snapshot = yield* manager.open({ ...input, host });
      preferences.set(input.threadId, host);
      return snapshot;
    }
    const details = yield* info;
    if (!details.available) return yield* new PreviewRemoteBrowserError({ reason: "unavailable" });
    const profileId = input.profileId ?? details.defaultProfileId;
    if (!details.profiles.some((entry) => entry.id === profileId))
      return yield* new PreviewRemoteBrowserError({ reason: "profile" });
    const url =
      input.assetRelativeUrl === undefined
        ? input.url
        : resolveRemoteAssetUrl(input.assetRelativeUrl, config.port);
    const snapshot = yield* manager.open({ ...input, url, host, profileId });
    yield* attempt(async () => {
      await (await browser()).open(snapshot, sync(snapshot));
    }).pipe(
      Effect.onError(() =>
        attempt(async () => {
          if (runtime?.hasPage(input.threadId, snapshot.tabId))
            await runtime.close(input.threadId, snapshot.tabId);
          await Effect.runPromise(
            manager.close({ threadId: input.threadId, tabId: snapshot.tabId }),
          );
          await persist(input.threadId);
        }).pipe(Effect.ignore),
      ),
    );
    preferences.set(input.threadId, host);
    yield* attempt(() => persist(input.threadId));
    const listed = yield* manager.list({ threadId: input.threadId });
    return listed.sessions.find((entry) => entry.tabId === snapshot.tabId) ?? snapshot;
  });

  const navigate: RemoteBrowser["Service"]["navigate"] = Effect.fn("RemoteBrowser.navigate")(
    function* (input) {
      const snapshot = yield* attempt(() => lookup(input));
      if (snapshot.host !== "environment") return yield* manager.navigate(input);
      yield* attempt(() =>
        serial(input.tabId, async () => {
          assertAgentControl(input.tabId);
          const engine = await browser();
          if (!engine.hasPage(input.threadId, input.tabId))
            await engine.open({ ...snapshot, navStatus: { _tag: "Idle" } }, sync(snapshot));
          const page = engine.page(input.threadId, input.tabId);
          await page.goto(normalizePreviewUrl(input.url), { waitUntil: "domcontentloaded" });
          await sync(snapshot)(page);
        }),
      );
      return yield* attempt(() => lookup(input));
    },
  );

  const resize: RemoteBrowser["Service"]["resize"] = Effect.fn("RemoteBrowser.resize")(
    function* (input) {
      const snapshot = yield* attempt(() => lookup(input));
      if (snapshot.host === "environment") {
        yield* attempt(() =>
          serial(input.tabId, async () => {
            const page = (await browser()).page(input.threadId, input.tabId);
            const size =
              input.viewport._tag === "fill" ? { width: 1280, height: 800 } : input.viewport;
            await page.setViewportSize(size);
          }),
        );
      }
      return yield* manager.resize(input);
    },
  );

  const refresh: RemoteBrowser["Service"]["refresh"] = Effect.fn("RemoteBrowser.refresh")(
    function* (input) {
      const snapshot = yield* attempt(() => lookup(input));
      if (snapshot.host !== "environment") return yield* manager.refresh(input);
      yield* attempt(() =>
        serial(input.tabId, async () => {
          assertAgentControl(input.tabId);
          const engine = await browser();
          if (!engine.hasPage(input.threadId, input.tabId))
            await engine.open(snapshot, sync(snapshot));
          else
            await engine
              .page(input.threadId, input.tabId)
              .reload({ waitUntil: "domcontentloaded" });
          const page = engine.page(input.threadId, input.tabId);
          await sync(snapshot)(page);
        }),
      );
    },
  );

  const close: RemoteBrowser["Service"]["close"] = Effect.fn("RemoteBrowser.close")(
    function* (input) {
      const listed = yield* manager.list({ threadId: input.threadId });
      for (const snapshot of listed.sessions) {
        if (input.tabId !== undefined && input.tabId !== snapshot.tabId) continue;
        if (snapshot.host === "environment" && runtime?.hasPage(input.threadId, snapshot.tabId)) {
          yield* attempt(() =>
            serial(snapshot.tabId, () => runtime!.close(input.threadId, snapshot.tabId)),
          );
        }
      }
      yield* manager.close(input);
      yield* attempt(() => persist(input.threadId));
    },
  );

  const control = (input: RemoteBrowserControlInput) =>
    attempt(() =>
      serial(input.tabId, async () => {
        const snapshot = await lookup(input);
        if (snapshot.host !== "environment")
          throw new PreviewRemoteBrowserError({ reason: "unsupported" });
        const existing = lease(input.tabId);
        if (input.action === "release") {
          if (existing?.viewerId === input.viewerId) controls.delete(input.tabId);
        } else {
          if (existing && existing.viewerId !== input.viewerId)
            throw new PreviewRemoteBrowserError({ reason: "busy" });
          if (input.action === "heartbeat" && existing?.viewerId !== input.viewerId)
            throw new PreviewRemoteBrowserError({ reason: "busy" });
          controls.set(input.tabId, {
            viewerId: input.viewerId,
            expiresAt: clock.currentTimeMillisUnsafe() + CONTROL_LEASE_MS,
          });
        }
        runtime?.notifyControlChange(input.tabId);
        const current = lease(input.tabId);
        return { controller: current?.viewerId ?? null, expiresAt: current?.expiresAt ?? null };
      }),
    );

  const input = (value: RemoteBrowserInput) =>
    attempt(() => {
      const run = async () => {
        const snapshot = await lookup(value);
        const current = lease(value.tabId);
        if (current?.viewerId !== value.viewerId)
          throw new PreviewRemoteBrowserError({ reason: "busy" });
        current.expiresAt = clock.currentTimeMillisUnsafe() + CONTROL_LEASE_MS;
        const engine = await browser();
        if (value.action._tag === "record") {
          if (value.action.action === "start")
            await engine.startRecording(value.threadId, value.tabId);
          else await stopRecording(snapshot, false);
          return;
        }
        if (!engine.hasPage(value.threadId, value.tabId)) {
          if (value.action._tag !== "reload" && value.action._tag !== "navigate")
            throw new PreviewRemoteBrowserError({ reason: "unavailable" });
          await engine.open(
            value.action._tag === "navigate"
              ? {
                  ...snapshot,
                  navStatus: {
                    _tag: "Loading",
                    url: normalizePreviewUrl(value.action.url),
                    title: "",
                  },
                }
              : snapshot,
            sync(snapshot),
          );
        } else await engine.input(value.threadId, value.tabId, value.action);
      };
      // A click can wait on a modal. Its response must not queue behind that click.
      return value.action._tag === "dialog" ? run() : serial(value.tabId, run);
    });

  const frames: RemoteBrowser["Service"]["frames"] = (target) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const snapshot = yield* attempt(() => lookup(target));
        if (snapshot.host !== "environment")
          return yield* new PreviewRemoteBrowserError({ reason: "unsupported" });
        const images = yield* Queue.sliding<RemoteBrowserFrame>(1);
        let sequence = 0;
        const unsubscribe = yield* Effect.acquireRelease(
          attempt(async () =>
            (await browser()).watch(target.threadId, target.tabId, (frame) => {
              const dialog = runtime?.dialogState(target.tabId);
              const value: RemoteBrowserFrame = {
                threadId: target.threadId,
                tabId: target.tabId,
                sequence: ++sequence,
                ...frame,
                controller: lease(target.tabId)?.viewerId ?? null,
                ...(dialog ? { dialog } : {}),
                fileChooser: runtime?.hasFileChooser(target.tabId) ?? false,
                downloads: downloads.get(target.tabId) ?? [],
                recording: runtime?.isRecording(target.tabId) ?? false,
              };
              void Effect.runPromise(Queue.offer(images, value));
            }),
          ),
          (stop) =>
            attempt(async () => {
              await stop();
              if (lease(target.tabId)?.viewerId === target.viewerId) controls.delete(target.tabId);
              runtime?.notifyControlChange(target.tabId);
            }).pipe(Effect.ignore),
        );
        void unsubscribe;
        return Stream.fromQueue(images);
      }),
    );

  const invoke: RemoteBrowser["Service"]["invoke"] = Effect.fn("RemoteBrowser.invoke")(
    function* (request) {
      const threadId = request.scope.threadId;
      const key = `${request.scope.environmentId}:${request.scope.providerSessionId}`;
      const sourceInput =
        typeof request.input === "object" && request.input !== null ? request.input : {};
      const explicitHost = "host" in sourceInput ? sourceInput.host : undefined;
      const tabId = request.tabId ?? currentTabs.get(key);
      const listed = yield* manager.list({ threadId });
      const snapshot = tabId
        ? listed.sessions.find((entry) => entry.tabId === tabId)
        : listed.sessions.findLast((entry) => entry.host === "environment");
      const chosenHost = explicitHost ?? snapshot?.host ?? preferences.get(threadId) ?? defaultHost;
      if (chosenHost !== "environment") return Option.none();
      if (request.tabId && snapshot?.host !== "environment")
        return yield* new PreviewSessionLookupError({ threadId, tabId: request.tabId });

      if (request.operation === "open") {
        const options = yield* attempt(async () => decodeOpen(sourceInput));
        if (
          options.reuseExistingTab !== false &&
          snapshot?.host === "environment" &&
          (options.profileId === undefined || options.profileId === snapshot.profileId)
        ) {
          currentTabs.set(key, snapshot.tabId);
          if (options.url) yield* navigate({ threadId, tabId: snapshot.tabId, url: options.url });
        } else {
          const opened = yield* open({
            threadId,
            host: "environment",
            url: options.url,
            profileId: options.profileId,
          });
          currentTabs.set(key, opened.tabId);
        }
        const activeId = currentTabs.get(key)!;
        request.onTargetTab?.(activeId);
        const page = yield* attempt(async () => (await browser()).page(threadId, activeId));
        return Option.some({
          available: true,
          visible: false,
          tabId: activeId,
          url: page.url(),
          title: yield* attempt(() => page.title()),
          loading: false,
          viewport: page.viewportSize() ?? { width: 1280, height: 800 },
        });
      }
      if (!snapshot) {
        if (request.operation === "status")
          return Option.some({
            available: true,
            visible: false,
            tabId: null,
            url: null,
            title: null,
            loading: false,
          });
        return yield* new PreviewRemoteBrowserError({ reason: "unavailable" });
      }
      const target = { threadId, tabId: snapshot.tabId };
      request.onTargetTab?.(snapshot.tabId);
      if (request.updateCurrentTab !== false) currentTabs.set(key, snapshot.tabId);
      const result = yield* attempt(() =>
        serial(snapshot.tabId, async () => {
          if (!READ_ONLY_OPERATIONS.has(request.operation)) assertAgentControl(snapshot.tabId);
          const engine = await browser();
          const page = engine.page(threadId, snapshot.tabId);
          switch (request.operation) {
            case "recordingStart":
              return engine.startRecording(threadId, snapshot.tabId);
            case "recordingStop":
              return stopRecording(snapshot, true);
            case "status":
              return {
                available: true,
                visible: false,
                tabId: snapshot.tabId,
                url: page.url(),
                title: await page.title(),
                loading: false,
                viewportSetting: snapshot.viewport,
                viewport: page.viewportSize() ?? { width: 1280, height: 800 },
              };
            case "snapshot":
              return engine.snapshot(threadId, snapshot.tabId);
            case "navigate": {
              const options = decodeNavigate(sourceInput);
              const destination = options.target;
              const url =
                destination?.kind === "url"
                  ? destination.url
                  : destination?.kind === "environment-port"
                    ? new URL(
                        destination.path ?? "/",
                        `${destination.protocol ?? "http"}://127.0.0.1:${destination.port}/`,
                      ).href
                    : options.url;
              if (!url) throw new PreviewRemoteBrowserError({ reason: "unsupported" });
              await page.goto(normalizePreviewUrl(url), {
                waitUntil:
                  options.readiness === "none"
                    ? "commit"
                    : options.readiness === "domContentLoaded"
                      ? "domcontentloaded"
                      : "load",
                timeout: options.timeoutMs ?? 15_000,
              });
              await sync(snapshot)(page);
              return {
                available: true,
                visible: false,
                tabId: snapshot.tabId,
                url: page.url(),
                title: await page.title(),
                loading: false,
              };
            }
            case "resize": {
              const options = decodeResize(sourceInput);
              const setting = resolvePreviewViewport(options);
              const viewport = setting._tag === "fill" ? { width: 1280, height: 800 } : setting;
              await page.setViewportSize(viewport);
              await Effect.runPromise(manager.resize({ ...target, viewport: setting }));
              return { tabId: target.tabId, viewportSetting: setting, viewport };
            }
            case "setColorScheme": {
              const options = decodeSetColorScheme(sourceInput);
              await page.emulateMedia({
                colorScheme: options.colorScheme === "system" ? null : options.colorScheme,
              });
              return { tabId: target.tabId, colorScheme: options.colorScheme };
            }
            case "click": {
              const options = decodeClick(sourceInput);
              if (options.locator ?? options.selector)
                await page
                  .locator((options.locator ?? options.selector)!)
                  .click({ timeout: options.timeoutMs ?? 15_000 });
              else await page.mouse.click(options.x!, options.y!);
              break;
            }
            case "type": {
              const options = decodeType(sourceInput);
              const locator = options.locator ?? options.selector;
              if (locator) {
                if (options.clear)
                  await page
                    .locator(locator)
                    .fill(options.text, { timeout: options.timeoutMs ?? 15_000 });
                else {
                  await page.locator(locator).focus({ timeout: options.timeoutMs ?? 15_000 });
                  await page.keyboard.insertText(options.text);
                }
              } else {
                if (options.clear) {
                  await page.keyboard.press("ControlOrMeta+A");
                  await page.keyboard.press("Backspace");
                }
                await page.keyboard.insertText(options.text);
              }
              break;
            }
            case "press": {
              const options = decodePress(sourceInput);
              await page.keyboard.press([...(options.modifiers ?? []), options.key].join("+"));
              break;
            }
            case "scroll": {
              const options = decodeScroll(sourceInput);
              const selector = options.locator ?? options.selector;
              if (selector)
                await page
                  .locator(selector)
                  .evaluate((element, delta) => element.scrollBy(delta.x, delta.y), {
                    x: options.deltaX ?? 0,
                    y: options.deltaY ?? 0,
                  });
              else await page.mouse.wheel(options.deltaX ?? 0, options.deltaY ?? 0);
              break;
            }
            case "evaluate": {
              const options = decodeEvaluate(sourceInput);
              const value: unknown = await page.evaluate(options.expression);
              if (Buffer.byteLength(JSON.stringify(value ?? null)) > 1_000_000)
                throw new PreviewRemoteBrowserError({ reason: "input" });
              return value;
            }
            case "waitFor": {
              const options = decodeWaitFor(sourceInput);
              const timeout = options.timeoutMs ?? 15_000;
              if (options.locator ?? options.selector)
                await page
                  .locator((options.locator ?? options.selector)!)
                  .waitFor({ state: "visible", timeout });
              if (options.text)
                await page.waitForFunction(
                  "(text) => document.body?.innerText.includes(text)",
                  options.text,
                  { timeout },
                );
              if (options.urlIncludes)
                await page.waitForURL((url) => url.href.includes(options.urlIncludes!), {
                  timeout,
                });
              break;
            }
            default:
              throw new PreviewRemoteBrowserError({ reason: "unsupported" });
          }
          await sync(snapshot)(page);
          return { tabId: target.tabId, ok: true };
        }),
      );
      return Option.some(result);
    },
  );

  return RemoteBrowser.of({
    info,
    profile,
    open,
    navigate,
    resize,
    refresh,
    close,
    control,
    input,
    frames,
    invoke,
  });
});

export const layer = Layer.effect(RemoteBrowser, make);

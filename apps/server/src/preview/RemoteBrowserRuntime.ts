import type { RemoteVideoRecorder } from "./RemoteBrowserRecording.ts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { Effect, type FileSystem, type Path } from "effect";
import * as NodeCrypto from "node:crypto";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Dialog,
  type FileChooser,
  type Page,
} from "playwright-core";
import {
  PreviewRemoteBrowserError,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationSnapshot,
  type PreviewSessionSnapshot,
  type RemoteBrowserAction,
} from "@t3tools/contracts";

export const remoteProfileDirectory = (root: string, profileId: string): string =>
  `${root.replace(/[\\/]+$/, "")}/${NodeCrypto.createHash("sha256").update(profileId).digest("hex")}`;

export async function findBrowserExecutable(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): Promise<string | undefined> {
  if (process.env.T3CODE_BROWSER_DISABLED === "1") return undefined;
  const configured = process.env.T3CODE_BROWSER_EXECUTABLE_PATH?.trim();
  const candidates = configured
    ? [configured]
    : [
        chromium.executablePath(),
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]]
          .filter(Boolean)
          .map((root) => path.join(root!, "Google", "Chrome", "Application", "chrome.exe")),
      ];
  for (const candidate of candidates) {
    if (await Effect.runPromise(fileSystem.exists(candidate))) return candidate;
  }
  return undefined;
}

export interface BrowserFrame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

interface RuntimeTab {
  readonly snapshot: PreviewSessionSnapshot;
  readonly page: Page;
  readonly console: PreviewAutomationConsoleEntry[];
  readonly network: PreviewAutomationNetworkEntry[];
  readonly observers: Set<(frame: BrowserFrame) => void>;
  readonly onState: (page: Page) => Promise<void>;
  cdp?: CDPSession | undefined;
  streamTask?: Promise<void> | undefined;
  lastFrame?: BrowserFrame | undefined;
  lastSentAt: number;
  dialog?: Dialog | undefined;
  fileChooser?: FileChooser | undefined;
}

interface RemoteBrowserRuntimeOptions {
  readonly profilesDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly now: () => number;
  readonly timestamp: () => string;
  readonly executablePath: string;
  readonly startRecording: (frame: () => BrowserFrame | undefined) => Promise<RemoteVideoRecorder>;
  readonly onPopup: (parent: PreviewSessionSnapshot, page: Page) => Promise<void>;
  readonly onClose: (snapshot: PreviewSessionSnapshot, intentional: boolean) => Promise<void>;
  readonly onDownload: (snapshot: PreviewSessionSnapshot, page: Page) => void;
}

/** Playwright/CDP is confined to this adapter. Viewer disposal never closes a page. */
export class RemoteBrowserRuntime {
  readonly #contexts = new Map<string, Promise<BrowserContext>>();
  readonly #tabs = new Map<string, RuntimeTab>();
  readonly #closing = new Set<string>();
  readonly #recordings = new Map<
    string,
    { recorder: RemoteVideoRecorder; stopWatching: () => Promise<void>; startedAt: string }
  >();
  #disposing = false;

  readonly options: RemoteBrowserRuntimeOptions;
  constructor(options: RemoteBrowserRuntimeOptions) {
    this.options = options;
  }

  async #context(profileId: string, threadId: string): Promise<BrowserContext> {
    // Incognito is isolated per thread and never written into a persistent profile.
    const key = profileId === "incognito" ? `incognito:${threadId}` : profileId;
    const existing = this.#contexts.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const common = {
        executablePath: this.options.executablePath,
        headless: true,
        chromiumSandbox: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      };
      const context =
        profileId === "incognito"
          ? await chromium
              .launch(common)
              .then((browser) => browser.newContext({ acceptDownloads: true }))
          : await (async () => {
              const directory = remoteProfileDirectory(this.options.profilesDir, profileId);
              await Effect.runPromise(
                this.options.fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }),
              );
              return chromium.launchPersistentContext(directory, {
                ...common,
                acceptDownloads: true,
                viewport: { width: 1280, height: 800 },
              });
            })();
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(15_000);
      context.on("close", () => this.#contexts.delete(key));
      return context;
    })();
    this.#contexts.set(key, pending);
    try {
      return await pending;
    } catch (cause) {
      this.#contexts.delete(key);
      throw cause;
    }
  }

  async open(snapshot: PreviewSessionSnapshot, onState: RuntimeTab["onState"]): Promise<void> {
    if (this.#tabs.size >= 64) throw new PreviewRemoteBrowserError({ reason: "busy" });
    const context = await this.#context(snapshot.profileId ?? "default", snapshot.threadId);
    const page = await context.newPage();
    this.adopt(snapshot, page, onState);
    if (snapshot.viewport && snapshot.viewport._tag !== "fill") {
      await page.setViewportSize(snapshot.viewport);
    }
    if (snapshot.navStatus._tag !== "Idle") {
      await page.goto(snapshot.navStatus.url, { waitUntil: "domcontentloaded" });
    }
    await onState(page);
  }

  adopt(snapshot: PreviewSessionSnapshot, page: Page, onState: RuntimeTab["onState"]): void {
    const tab: RuntimeTab = {
      snapshot,
      page,
      onState,
      console: [],
      network: [],
      observers: new Set(),
      lastSentAt: 0,
    };
    this.#tabs.set(snapshot.tabId, tab);
    const sync = () => {
      void onState(page).catch(() => undefined);
    };
    page.on("domcontentloaded", sync);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) sync();
    });
    page.on("console", (message) => {
      tab.console.push({
        level: message.type(),
        text: message.text().slice(0, 4000),
        timestamp: this.options.timestamp(),
      });
      if (tab.console.length > 50) tab.console.shift();
    });
    page.on("pageerror", (error) => {
      tab.console.push({
        level: "error",
        text: error.message.slice(0, 4000),
        timestamp: this.options.timestamp(),
      });
      if (tab.console.length > 50) tab.console.shift();
    });
    page.on("response", (response) => {
      tab.network.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: this.options.timestamp(),
      });
      if (tab.network.length > 100) tab.network.shift();
    });
    page.on("requestfailed", (request) => {
      tab.network.push({
        url: request.url(),
        method: request.method(),
        status: null,
        failed: true,
        errorText: request.failure()?.errorText ?? "Request failed",
        timestamp: this.options.timestamp(),
      });
      if (tab.network.length > 100) tab.network.shift();
    });
    page.on("dialog", (dialog) => {
      tab.dialog = dialog;
      this.#emitLastFrame(tab);
    });
    page.on("filechooser", (chooser) => {
      tab.fileChooser = chooser;
      this.#emitLastFrame(tab);
    });
    page.on("popup", (popup) => {
      void this.options.onPopup(snapshot, popup).catch(() => popup.close());
    });
    page.on("close", () => {
      const recording = this.#recordings.get(snapshot.tabId);
      if (recording) {
        this.#recordings.delete(snapshot.tabId);
        void recording.recorder.dispose().catch(() => undefined);
      }
      this.#tabs.delete(snapshot.tabId);
      if (!this.#disposing)
        void this.options
          .onClose(snapshot, this.#closing.has(snapshot.tabId))
          .catch(() => undefined);
      this.#closing.delete(snapshot.tabId);
    });
    this.options.onDownload(snapshot, page);
  }

  page(threadId: string, tabId: string): Page {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.snapshot.threadId !== threadId || tab.page.isClosed()) {
      throw new PreviewRemoteBrowserError({ reason: "unavailable" });
    }
    return tab.page;
  }

  hasPage(threadId: string, tabId: string): boolean {
    const tab = this.#tabs.get(tabId);
    return tab?.snapshot.threadId === threadId && !tab.page.isClosed();
  }

  dialogState(tabId: string): { type: string; message: string } | undefined {
    const dialog = this.#tabs.get(tabId)?.dialog;
    return dialog ? { type: dialog.type(), message: dialog.message() } : undefined;
  }

  hasFileChooser(tabId: string): boolean {
    return this.#tabs.get(tabId)?.fileChooser !== undefined;
  }

  isRecording(tabId: string): boolean {
    return this.#recordings.has(tabId);
  }

  async startRecording(threadId: string, tabId: string) {
    const existing = this.#recordings.get(tabId);
    if (existing) return { tabId, recording: true, startedAt: existing.startedAt };
    const stopWatching = await this.watch(threadId, tabId, () => undefined);
    try {
      const recorder = await this.options.startRecording(() => this.#tabs.get(tabId)?.lastFrame);
      const startedAt = this.options.timestamp();
      this.#recordings.set(tabId, { recorder, stopWatching, startedAt });
      this.notifyControlChange(tabId);
      return { tabId, recording: true, startedAt };
    } catch (cause) {
      await stopWatching();
      throw cause;
    }
  }

  async stopRecording(threadId: string, tabId: string): Promise<Buffer> {
    this.page(threadId, tabId);
    const recording = this.#recordings.get(tabId);
    if (!recording) throw new PreviewRemoteBrowserError({ reason: "input" });
    this.#recordings.delete(tabId);
    try {
      return await recording.recorder.stop();
    } finally {
      await recording.stopWatching();
      this.notifyControlChange(tabId);
    }
  }

  #emitLastFrame(tab: RuntimeTab): void {
    if (tab.lastFrame) for (const observer of tab.observers) observer(tab.lastFrame);
  }

  async #withStreamLock(tab: RuntimeTab, action: () => Promise<void>): Promise<void> {
    const previous = tab.streamTask ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    tab.streamTask = next;
    try {
      await next;
    } finally {
      if (tab.streamTask === next) tab.streamTask = undefined;
    }
  }

  async watch(
    threadId: string,
    tabId: string,
    observer: (frame: BrowserFrame) => void,
  ): Promise<() => Promise<void>> {
    this.page(threadId, tabId);
    const tab = this.#tabs.get(tabId)!;
    await this.#withStreamLock(tab, async () => {
      tab.observers.add(observer);
      if (tab.lastFrame) observer(tab.lastFrame);
      if (tab.cdp) return;
      try {
        const cdp = await tab.page.context().newCDPSession(tab.page);
        tab.cdp = cdp;
        cdp.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
          void cdp
            .send("Page.screencastFrameAck", { sessionId: event.sessionId })
            .catch(() => undefined);
          const now = this.options.now();
          if (now - tab.lastSentAt < 67 || event.data.length > 4_000_000) return;
          tab.lastSentAt = now;
          const viewport = tab.page.viewportSize() ?? { width: 1280, height: 800 };
          tab.lastFrame = { data: event.data, ...viewport };
          this.#emitLastFrame(tab);
        });
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: 65,
          maxWidth: 1920,
          maxHeight: 1080,
          everyNthFrame: 1,
        });
        const viewport = tab.page.viewportSize() ?? { width: 1280, height: 800 };
        const image = await tab.page.screenshot({ type: "jpeg", quality: 65 });
        tab.lastFrame = { data: image.toString("base64"), ...viewport };
        this.#emitLastFrame(tab);
      } catch (cause) {
        tab.observers.delete(observer);
        await tab.cdp?.detach().catch(() => undefined);
        tab.cdp = undefined;
        throw cause;
      }
    });
    return () =>
      this.#withStreamLock(tab, async () => {
        tab.observers.delete(observer);
        if (tab.observers.size !== 0) return;
        await tab.cdp?.send("Page.stopScreencast").catch(() => undefined);
        await tab.cdp?.detach().catch(() => undefined);
        tab.cdp = undefined;
      });
  }

  notifyControlChange(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    if (tab) this.#emitLastFrame(tab);
  }

  async input(threadId: string, tabId: string, action: RemoteBrowserAction): Promise<void> {
    const page = this.page(threadId, tabId);
    const tab = this.#tabs.get(tabId)!;
    switch (action._tag) {
      case "navigate":
        await page.goto(normalizePreviewUrl(action.url), { waitUntil: "domcontentloaded" });
        break;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded" });
        break;
      case "pointer": {
        const size = page.viewportSize() ?? { width: 1280, height: 800 };
        if (action.x > size.width || action.y > size.height)
          throw new PreviewRemoteBrowserError({ reason: "input" });
        await page.mouse.move(action.x, action.y);
        if (action.phase === "down")
          await page.mouse.down({
            button: action.button ?? "left",
            clickCount: action.clickCount ?? 1,
          });
        if (action.phase === "up")
          await page.mouse.up({
            button: action.button ?? "left",
            clickCount: action.clickCount ?? 1,
          });
        break;
      }
      case "wheel":
        await page.mouse.wheel(action.deltaX, action.deltaY);
        break;
      case "key":
        await page.keyboard.press(action.key);
        break;
      case "text":
        await page.keyboard.insertText(action.text);
        break;
      case "history":
        if (action.direction === "back") await page.goBack({ waitUntil: "domcontentloaded" });
        else await page.goForward({ waitUntil: "domcontentloaded" });
        break;
      case "dialog":
        if (!tab.dialog) throw new PreviewRemoteBrowserError({ reason: "input" });
        if (action.accept) await tab.dialog.accept(action.promptText);
        else await tab.dialog.dismiss();
        tab.dialog = undefined;
        break;
      case "upload": {
        const buffer = Buffer.from(action.data, "base64");
        if (buffer.byteLength > 16_000_000 || buffer.toString("base64") !== action.data)
          throw new PreviewRemoteBrowserError({ reason: "input" });
        const file = {
          name: this.options.path.basename(action.name),
          mimeType: action.mimeType,
          buffer,
        };
        if (tab.fileChooser) {
          await tab.fileChooser.setFiles(file);
          tab.fileChooser = undefined;
        } else await page.locator('input[type="file"]').first().setInputFiles(file);
        break;
      }
    }
    if (["navigate", "reload", "history", "dialog"].includes(action._tag)) await tab.onState(page);
    this.#emitLastFrame(tab);
  }

  async snapshot(threadId: string, tabId: string): Promise<PreviewAutomationSnapshot> {
    const page = this.page(threadId, tabId);
    const tab = this.#tabs.get(tabId)!;
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const [visibleText, accessibilityTree, interactiveElements, screenshot, title] =
      await Promise.all([
        page
          .locator("body")
          .innerText()
          .catch(() => ""),
        page
          .locator("body")
          .ariaSnapshot()
          .catch(() => ""),
        page
          .locator(
            'a,button,input,select,textarea,[role="button"],[role="textbox"],[contenteditable="true"]',
          )
          .evaluateAll((elements) =>
            elements.slice(0, 100).flatMap((element) => {
              const rect = element.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) return [];
              const tag = element.tagName.toLowerCase();
              const name =
                element.getAttribute("aria-label") ??
                element.getAttribute("placeholder") ??
                element.textContent?.trim().slice(0, 160) ??
                "";
              const selector = `:nth-match(${tag}, ${Array.from(element.ownerDocument.querySelectorAll(tag)).indexOf(element) + 1})`;
              return [
                {
                  tag,
                  role: element.getAttribute("role"),
                  name,
                  selector,
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
              ];
            }),
          ),
        page.screenshot({ type: "png" }),
        page.title(),
      ]);
    return {
      url: page.url(),
      title,
      loading: false,
      visibleText: visibleText.slice(0, 40_000),
      interactiveElements,
      accessibilityTree,
      consoleEntries: [...tab.console],
      networkEntries: [...tab.network],
      actionTimeline: [],
      screenshot: { mimeType: "image/png", data: screenshot.toString("base64"), ...viewport },
    };
  }

  async close(threadId: string, tabId: string): Promise<void> {
    const page = this.page(threadId, tabId);
    this.#closing.add(tabId);
    await page.close({ runBeforeUnload: false });
  }

  async dispose(): Promise<void> {
    this.#disposing = true;
    await Promise.allSettled(
      [...this.#recordings.values()].map((recording) => recording.recorder.dispose()),
    );
    this.#recordings.clear();
    await Promise.allSettled(
      [...this.#contexts.values()].map(async (pending) => {
        const context = await pending;
        const browser = context.browser();
        await context.close();
        if (browser?.isConnected()) await browser.close();
      }),
    );
    this.#contexts.clear();
    this.#tabs.clear();
  }
}

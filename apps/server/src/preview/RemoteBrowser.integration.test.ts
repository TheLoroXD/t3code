import * as NodeServices from "@effect/platform-node/NodeServices";
// The fixture owns an HTTP listener rather than an HttpClient transport.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { Deferred, Effect, Fiber, FileSystem, Option, Path, Stream } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationOperation,
} from "@t3tools/contracts";
import { makeRemoteBrowserTestHost } from "./RemoteBrowserTestHost.ts";

const enabled = process.env.T3CODE_TEST_REMOTE_BROWSER === "1";
const scope = {
  environmentId: EnvironmentId.make("test-host"),
  threadId: ThreadId.make("remote-test-thread"),
  providerSessionId: "test-agent",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const markup = `<!doctype html><title>Remote browser fixture</title><h1>Host browser test</h1><form><label>Message <input id="message" name="message"></label><button type="submit">Save</button></form><p id="result"></p><button id="alert" onclick="alert('Host dialog');document.querySelector('#result').textContent='Dialog accepted'">Alert</button><input id="upload" type="file" onchange="this.files[0].text().then(text=>document.querySelector('#result').textContent='Uploaded: '+text)"><a href="/download" download="proof.txt">Download</a><script>document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();const message=document.querySelector('#message').value;await fetch('/save',{method:'POST',body:message});document.querySelector('#result').textContent='Saved: '+message};</script>`;

const fixture = Effect.gen(function* () {
  const submitted: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    if (request.url === "/save") {
      let text = "";
      request.on("data", (chunk) => {
        text += chunk;
      });
      request.on("end", () => {
        submitted.push(text);
        response.end("ok");
      });
    } else if (request.url === "/download") {
      response.setHeader("content-type", "text/plain");
      response.setHeader("content-disposition", 'attachment; filename="proof.txt"');
      response.end("downloaded-on-host");
    } else {
      response.setHeader("content-type", "text/html");
      response.end(markup);
    }
  });
  yield* Effect.acquireRelease(
    Effect.callback<void, Error>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void, never>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") return yield* Effect.die("No fixture port");
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-real-remote-browser-" });
  const host = yield* makeRemoteBrowserTestHost(root);
  const invoke = (operation: PreviewAutomationOperation, input: unknown, tabId?: string) =>
    host.browser
      .invoke({ scope, operation, input, ...(tabId ? { tabId } : {}) })
      .pipe(
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.die("Operation incorrectly routed to a client"),
        ),
      );
  return { host, root, invoke, submitted, origin: `http://127.0.0.1:${address.port}` };
});

describe.skipIf(!enabled)("real host browser", () => {
  it.effect(
    "completes a form after its stream viewer has disconnected and reconnects to the same page",
    () =>
      Effect.gen(function* () {
        const { host, invoke, submitted, origin } = yield* fixture;
        const snapshot = yield* host.browser.open({
          threadId: scope.threadId,
          host: "environment",
          url: origin,
        });
        const target = { threadId: scope.threadId, tabId: snapshot.tabId };
        const frame = yield* Stream.runCollect(
          Stream.take(host.browser.frames({ ...target, viewerId: "first-viewer" }), 1),
        );
        expect(frame[0]?.data.length).toBeGreaterThan(100);
        expect(frame[0]?.width).toBe(1280);
        yield* invoke(
          "type",
          { selector: "#message", text: "finished-without-viewer", clear: true },
          snapshot.tabId,
        );
        yield* invoke("click", { locator: "role=button[name='Save']" }, snapshot.tabId);
        yield* invoke("waitFor", { text: "Saved: finished-without-viewer" }, snapshot.tabId);
        expect(submitted).toContain("finished-without-viewer");
        const secondFrame = yield* Stream.runCollect(
          Stream.take(host.browser.frames({ ...target, viewerId: "second-viewer" }), 1),
        );
        expect(secondFrame[0]?.tabId).toBe(snapshot.tabId);
        expect(
          yield* invoke(
            "evaluate",
            { expression: "document.querySelector('#result').textContent" },
            snapshot.tabId,
          ),
        ).toBe("Saved: finished-without-viewer");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "permits one human controller, blocks agent writes and releases control when that viewer disconnects",
    () =>
      Effect.gen(function* () {
        const { host, invoke, origin } = yield* fixture;
        const snapshot = yield* host.browser.open({
          threadId: scope.threadId,
          host: "environment",
          url: origin,
        });
        const target = { threadId: scope.threadId, tabId: snapshot.tabId };
        yield* host.browser.control({ ...target, viewerId: "owner", action: "acquire" });
        expect(
          yield* host.browser
            .control({ ...target, viewerId: "other", action: "acquire" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "busy" });
        expect(
          yield* invoke(
            "type",
            { selector: "#message", text: "should-not-write" },
            snapshot.tabId,
          ).pipe(Effect.catch((error) => Effect.succeed(error))),
        ).toMatchObject({ reason: "busy" });
        yield* Stream.runCollect(
          Stream.take(host.browser.frames({ ...target, viewerId: "owner" }), 1),
        );
        yield* invoke(
          "type",
          { selector: "#message", text: "agent-resumed", clear: true },
          snapshot.tabId,
        );
        expect(
          yield* invoke(
            "evaluate",
            { expression: "document.querySelector('#message').value" },
            snapshot.tabId,
          ),
        ).toBe("agent-resumed");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "isolates cookies between profiles and restores persistent cookies after a browser restart",
    () =>
      Effect.gen(function* () {
        const { host, invoke, origin, root } = yield* fixture;
        const firstInfo = yield* host.browser.profile({ name: "Work" });
        const work = firstInfo.profiles.find((entry) => entry.name === "Work")!;
        const secondInfo = yield* host.browser.profile({ name: "Personal" });
        const personal = secondInfo.profiles.find((entry) => entry.name === "Personal")!;
        const first = yield* host.browser.open({
          threadId: scope.threadId,
          host: "environment",
          profileId: work.id,
          url: origin,
        });
        yield* invoke(
          "evaluate",
          { expression: "document.cookie='identity=work; Max-Age=3600; Path=/'" },
          first.tabId,
        );
        const second = yield* host.browser.open({
          threadId: scope.threadId,
          host: "environment",
          profileId: personal.id,
          url: origin,
        });
        expect(
          yield* invoke("evaluate", { expression: "document.cookie" }, second.tabId),
        ).not.toContain("identity=work");
        yield* host.dispose;
        const restarted = yield* makeRemoteBrowserTestHost(root);
        const restored = yield* restarted.browser.open({
          threadId: scope.threadId,
          host: "environment",
          profileId: work.id,
          url: origin,
        });
        const result = yield* restarted.browser.invoke({
          scope,
          operation: "evaluate",
          input: { expression: "document.cookie" },
          tabId: restored.tabId,
        });
        expect(Option.getOrNull(result)).toContain("identity=work");
        const otherThread = { ...scope, threadId: ThreadId.make("wrong-thread") };
        expect(
          yield* restarted.browser
            .invoke({
              scope: otherThread,
              operation: "evaluate",
              input: { expression: "document.cookie" },
              tabId: restored.tabId,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "PreviewSessionLookupError" });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts a human dialog response while the triggering input is still in flight", () =>
    Effect.gen(function* () {
      const { host, invoke, origin } = yield* fixture;
      const opened = yield* host.browser.open({
        threadId: scope.threadId,
        host: "environment",
        url: origin,
      });
      const target = { threadId: scope.threadId, tabId: opened.tabId };
      yield* invoke(
        "evaluate",
        { expression: "document.querySelector('#alert').focus()" },
        opened.tabId,
      );
      const first = yield* Deferred.make<void>();
      const dialog = yield* Deferred.make<void>();
      const viewer = yield* Stream.runForEach(
        host.browser.frames({ ...target, viewerId: "observer" }),
        (frame) =>
          Effect.all([
            Deferred.succeed(first, undefined),
            frame.dialog?.message === "Host dialog"
              ? Deferred.succeed(dialog, undefined)
              : Effect.void,
          ]),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(first);
      yield* host.browser.control({ ...target, viewerId: "human", action: "acquire" });
      const press = yield* host.browser
        .input({ ...target, viewerId: "human", action: { _tag: "key", key: "Enter" } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(dialog);
      yield* host.browser.input({
        ...target,
        viewerId: "human",
        action: { _tag: "dialog", accept: true },
      });
      yield* Fiber.join(press);
      yield* invoke("waitFor", { text: "Dialog accepted" }, opened.tabId);
      yield* Fiber.interrupt(viewer);
      yield* host.browser.control({ ...target, viewerId: "human", action: "release" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uploads human-selected bytes and saves a downloadable file on the host", () =>
    Effect.gen(function* () {
      const { host, invoke, origin } = yield* fixture;
      const opened = yield* host.browser.open({
        threadId: scope.threadId,
        host: "environment",
        url: origin,
      });
      const target = { threadId: scope.threadId, tabId: opened.tabId };
      yield* host.browser.control({ ...target, viewerId: "human-file", action: "acquire" });
      yield* host.browser.input({
        ...target,
        viewerId: "human-file",
        action: {
          _tag: "upload",
          name: "from-client.txt",
          mimeType: "text/plain",
          data: Buffer.from("uploaded-from-client").toString("base64"),
        },
      });
      yield* invoke("waitFor", { text: "Uploaded: uploaded-from-client" }, opened.tabId);
      yield* host.browser.control({ ...target, viewerId: "human-file", action: "release" });
      const download = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            host.browser.frames({ ...target, viewerId: "download-viewer" }),
            (frame) => (frame.downloads?.length ?? 0) > 0,
          ),
          1,
        ),
      ).pipe(Effect.forkScoped);
      yield* invoke("click", { selector: "a[download]" }, opened.tabId);
      const frames = yield* Fiber.join(download);
      const saved = frames[0]!.downloads![0]!;
      expect(saved.name).toBe("proof.txt");
      expect(saved.sizeBytes).toBe(Buffer.byteLength("downloaded-on-host"));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(
        yield* fs.readFileString(
          path.join(host.config.attachmentsDir, `${saved.attachmentId}.txt`),
        ),
      ).toBe("downloaded-on-host");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "restores tab identity after a host restart without automatically opening or replaying the page",
    () =>
      Effect.gen(function* () {
        const { host, invoke, submitted, root, origin } = yield* fixture;
        const opened = yield* host.browser.open({
          threadId: scope.threadId,
          host: "environment",
          url: origin,
        });
        yield* invoke(
          "type",
          { selector: "#message", text: "must-not-replay", clear: true },
          opened.tabId,
        );
        const submissionsBefore = submitted.length;
        yield* host.dispose;
        const restarted = yield* makeRemoteBrowserTestHost(root);
        const listed = yield* restarted.manager.list({ threadId: scope.threadId });
        expect(listed.sessions.find((tab) => tab.tabId === opened.tabId)?.navStatus._tag).toBe(
          "LoadFailed",
        );
        expect(
          yield* restarted.browser
            .invoke({ scope, operation: "snapshot", input: {}, tabId: opened.tabId })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "unavailable" });
        yield* restarted.browser.refresh({ threadId: scope.threadId, tabId: opened.tabId });
        expect(
          Option.getOrNull(
            yield* restarted.browser.invoke({
              scope,
              operation: "evaluate",
              input: { expression: "document.querySelector('#message').value" },
              tabId: opened.tabId,
            }),
          ),
        ).toBe("");
        expect(submitted.length).toBe(submissionsBefore);
        expect(
          Option.getOrNull(
            yield* restarted.browser.invoke({
              scope,
              operation: "status",
              input: {},
              tabId: opened.tabId,
            }),
          ),
        ).toMatchObject({ tabId: opened.tabId, url: origin + "/" });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3CODE_TEST_BROWSER_RECORDING !== "1")(
    "records the host browser without an attached viewer",
    () =>
      Effect.gen(function* () {
        const { host, invoke, origin } = yield* fixture;
        const opened = yield* host.browser.open({
          threadId: scope.threadId,
          host: "environment",
          url: origin,
        });
        expect(yield* invoke("recordingStart", {}, opened.tabId)).toMatchObject({
          recording: true,
          tabId: opened.tabId,
        });
        yield* invoke(
          "type",
          { selector: "#message", text: "recorded-on-host", clear: true },
          opened.tabId,
        );
        yield* invoke("click", { selector: "button[type='submit']" }, opened.tabId);
        yield* invoke("waitFor", { text: "Saved: recorded-on-host" }, opened.tabId);
        const video = (yield* invoke("recordingStop", {}, opened.tabId)) as {
          path: string;
          sizeBytes: number;
          uploadedAttachmentId: string;
        };
        expect(video.sizeBytes).toBeGreaterThan(1000);
        expect(video.uploadedAttachmentId).toBeTruthy();
        const fs = yield* FileSystem.FileSystem;
        const bytes = yield* fs.readFile(video.path);
        expect(bytes.length).toBe(video.sizeBytes);
        expect(Buffer.from(bytes).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

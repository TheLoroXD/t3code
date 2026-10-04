import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { makeRemoteBrowserTestHost } from "./RemoteBrowserTestHost.ts";
import { remoteProfileDirectory } from "./RemoteBrowserRuntime.ts";

afterEach(() => vi.unstubAllEnvs());

describe("remote browser ownership and profiles", () => {
  it.effect(
    "stores profile identities on the server and retains them across service restarts",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("T3CODE_BROWSER_DISABLED", "1");
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-profiles-" });
        const first = yield* makeRemoteBrowserTestHost(root);
        const created = yield* first.browser.profile({ name: "Personal" });
        const profile = created.profiles.find((entry) => entry.name === "Personal")!;
        yield* first.dispose;
        const second = yield* makeRemoteBrowserTestHost(root);
        const restored = yield* second.browser.info;
        expect(restored.profiles).toContainEqual(profile);
        expect(restored.defaultProfileId).toBe(profile.id);
        expect(restored.available).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not create a client tab when the explicitly selected environment browser is unavailable",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("T3CODE_BROWSER_DISABLED", "1");
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-no-fallback-" });
        const host = yield* makeRemoteBrowserTestHost(root);
        const threadId = ThreadId.make("thread-no-fallback");
        const error = yield* host.browser.open({ threadId, host: "environment" }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "PreviewRemoteBrowserError", reason: "unavailable" });
        expect((yield* host.manager.list({ threadId })).sessions).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps client ownership fixed through navigation, resize and status reports", () =>
    Effect.gen(function* () {
      vi.stubEnv("T3CODE_BROWSER_DISABLED", "1");
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-client-owner-" });
      const host = yield* makeRemoteBrowserTestHost(root);
      const threadId = ThreadId.make("thread-local-owner");
      const snapshot = yield* host.browser.open({
        threadId,
        host: "client",
        profileId: "local-work",
      });
      const navigated = yield* host.browser.navigate({
        threadId,
        tabId: snapshot.tabId,
        url: "localhost:5173",
      });
      expect(navigated.host).toBe("client");
      expect(navigated.profileId).toBe("local-work");
      yield* host.manager.reportStatus({
        threadId,
        tabId: snapshot.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Local" },
        canGoBack: false,
        canGoForward: false,
      });
      expect((yield* host.manager.list({ threadId })).sessions[0]?.host).toBe("client");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("never interpolates a profile ID into a filesystem path", () => {
    const traversal = remoteProfileDirectory("/tmp/profiles", "../../outside");
    expect(traversal).toMatch(/^\/tmp\/profiles\/[a-f0-9]{64}$/);
    expect(traversal).not.toBe(remoteProfileDirectory("/tmp/profiles", "personal"));
  });
});

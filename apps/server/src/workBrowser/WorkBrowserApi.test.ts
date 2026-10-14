import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationUnavailableError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as ServerConfig from "../config.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as AccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import * as Handlers from "../mcp/toolkits/workBrowser/handlers.ts";
import { WorkBrowserToolkit } from "../mcp/toolkits/workBrowser/tools.ts";
import * as WorkBrowser from "./WorkBrowser.ts";
import { type Configuration, type Request, type Result, WorkBrowserError } from "./schema.ts";
import { type SlackPageRequest, type SlackPageResult } from "./readSchema.ts";

const scope = {
  environmentId: EnvironmentId.make("api-test-env"),
  requestNamespace: "api-tests",
  issuedAt: 1,
  capabilities: new Set(["preview"] as const),
  client: undefined,
  thread: {
    threadId: ThreadId.make("api-test-thread"),
    providerSessionId: "test-agent",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
const configuration: Configuration = {
  account: "verato",
  profileId: "profile-verato",
  slackUrl: "https://app.slack.com/client/TWORK",
  accountEmail: "person@work.example",
  readBackends: { slackSearch: "api", slackRead: "api" },
  slackApi: {
    environmentId: scope.environmentId,
    teamId: "TWORK",
    userId: "UWORK",
    enterpriseId: "EWORK",
    workspaceOrigin: "https://work.slack.com",
    searchScope: "enterprise",
  },
};
const isWorkBrowserError = Schema.is(WorkBrowserError);
const item = (page: number, text = "Synthetic message") => ({
  id: `179193972${page}.315089`,
  channel: "CGENERAL",
  threadTs: `179193972${page}.315089`,
  text,
  author: "UWORK",
  sourceUrl: `https://work.slack.com/archives/CGENERAL/p179193972${page}315089`,
  timestamp: `179193972${page}.315089`,
  partial: false,
});
const inThread = (message: ReturnType<typeof item>, rootTs: string) => ({
  ...message,
  threadTs: rootTs,
  sourceUrl: message.id === rootTs ? message.sourceUrl : `${message.sourceUrl}?thread_ts=${rootTs}`,
});
type Harness = {
  requests: Broker.PreviewAutomationInvokeInput[];
  unavailable: boolean;
  human: boolean;
  respond: (input: SlackPageRequest) => Effect.Effect<SlackPageResult>;
  restart: () => Effect.Effect<WorkBrowser.WorkBrowser["Service"]>;
};
const withService = <A, E>(
  run: (
    service: WorkBrowser.WorkBrowser["Service"],
    fixture: Harness,
  ) => Effect.Effect<A, E, Invocation.McpInvocationContext>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture: Harness = {
        requests: [],
        unavailable: false,
        human: false,
        restart: () => Effect.die("restart fixture not initialized"),
        respond: (input) =>
          Effect.succeed(
            input.operation === "identity"
              ? { ok: true, items: [], more: false }
              : input.operation === "search"
                ? {
                    ok: true,
                    items: [item(input.page ?? 1)],
                    more: (input.page ?? 1) === 1,
                    ...((input.page ?? 1) === 1 ? { nextPage: 2 } : {}),
                  }
                : { ok: true, items: [item(1)], more: false },
          ),
      };
      const broker = Layer.mock(Broker.PreviewAutomationBroker)({
        invoke: <T>(request: Broker.PreviewAutomationInvokeInput) =>
          Effect.suspend(() => {
            fixture.requests.push(request);
            if (request.operation === "workRead")
              return fixture
                .respond(request.input as SlackPageRequest)
                .pipe(Effect.map((value) => value as T));
            if (request.operation === "workOpen" || request.operation === "status")
              return Effect.succeed({
                available: !fixture.unavailable,
                tabId: PreviewTabId.make("private-tab"),
                control: {
                  owner: fixture.human ? "human" : "agent",
                  ownedByCaller: !fixture.human,
                  generation: 0,
                },
              } as T);
            if (request.operation === "evaluate")
              return Effect.succeed({
                state: "ready",
                url: configuration.slackUrl,
                account: configuration.accountEmail,
                items: [],
                more: false,
                locator: "[data-work-browser-control]",
                point: { x: 1, y: 1 },
              } as T);
            return Effect.succeed(undefined as T);
          }),
      });
      const dependencies = Layer.mergeAll(
        broker,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-api-read-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        for (const profile of ["profile-verato", "profile-onecall"])
          yield* fs.makeDirectory(
            path.join(config.stateDir, "server-browser", "profiles", profile),
            { recursive: true },
          );
        const service = yield* WorkBrowser.WorkBrowser;
        const serviceContext = yield* Effect.context<
          | Broker.PreviewAutomationBroker
          | FileSystem.FileSystem
          | Path.Path
          | ServerConfig.ServerConfig
          | Crypto.Crypto
        >();
        fixture.restart = () =>
          WorkBrowser.WorkBrowser.pipe(
            Effect.provide(Layer.fresh(WorkBrowser.layer)),
            Effect.provideContext(serviceContext),
          );
        yield* service.configure(configuration);
        return yield* run(service, fixture);
      }).pipe(
        Effect.provide(WorkBrowser.layer.pipe(Layer.provideMerge(dependencies))),
        Effect.provideService(Invocation.McpInvocationContext, scope),
      );
    }),
  );
const searchRequest: Request = {
  operation: "slackSearch",
  account: "verato",
  query: "fixture",
  limit: 1,
};
const apiInputs = (fixture: Harness) =>
  fixture.requests
    .filter((r) => r.operation === "workRead")
    .map((r) => r.input as SlackPageRequest);
const expectCode = (
  effect: Effect.Effect<
    Result | Configuration,
    WorkBrowserError | PreviewAutomationUnavailableError,
    Invocation.McpInvocationContext
  >,
  code: string,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(isWorkBrowserError(result.failure)).toBe(true);
      if (isWorkBrowserError(result.failure)) expect(result.failure.code).toBe(code);
    }
  });

it.live(
  "paginates through account-bound cursors, reverifies identity and reads the selected thread",
  () =>
    withService((service, fixture) =>
      Effect.gen(function* () {
        const first = yield* service.run(searchRequest);
        expect(first).toMatchObject({
          backend: "api",
          coverage: "enterprise",
          partial: true,
          state: "ready",
        });
        expect(first.cursor).toBeDefined();
        expect(first.items).toHaveLength(1);
        const second = yield* service.run({ ...searchRequest, cursor: first.cursor! });
        expect(second).toMatchObject({ partial: false, backend: "api" });
        expect(second.items[0]!.ref).not.toBe(first.items[0]!.ref);
        expect(apiInputs(fixture).map((r) => r.operation)).toEqual([
          "identity",
          "search",
          "identity",
          "search",
        ]);
        expect(
          apiInputs(fixture)
            .filter((r) => r.operation === "search")
            .map((r) => r.page),
        ).toEqual([1, 2]);
        const read = yield* service.run({
          operation: "slackRead",
          account: "verato",
          messageRef: first.items[0]!.ref,
        });
        expect(read.coverage).toBe("thread");
        expect(read.items[0]!.text).toBe("Synthetic message");
        yield* expectCode(
          service.run({ ...searchRequest, query: "other", cursor: first.cursor! }),
          "invalid_cursor",
        );
        yield* expectCode(
          service.run({ ...searchRequest, limit: 2, cursor: first.cursor! }),
          "invalid_cursor",
        );
        yield* service.configure({
          ...configuration,
          readBackends: { slackSearch: "dom", slackRead: "dom" },
        });
        yield* expectCode(
          service.run({ ...searchRequest, cursor: first.cursor! }),
          "invalid_cursor",
        );
        yield* expectCode(
          service.run({
            operation: "slackRead",
            account: "verato",
            messageRef: first.items[0]!.ref,
          }),
          "invalid_reference",
        );
        const dom = yield* service.run(searchRequest);
        expect(dom.backend).toBe("dom");
        expect(dom.coverage).toBe("rendered");
      }),
    ),
);

it.live(
  "keeps DOM as the default and rejects operations and accounts absent from capability evidence",
  () =>
    withService((service, fixture) =>
      Effect.gen(function* () {
        const { readBackends: _backends, slackApi: _identity, ...domConfiguration } = configuration;
        yield* service.configure(domConfiguration);
        const result = yield* service.run(searchRequest);
        expect(result.backend).toBe("dom");
        expect(apiInputs(fixture)).toHaveLength(0);
        yield* expectCode(
          service.configure({ ...configuration, readBackends: { mailSearch: "api" } }),
          "capability_unavailable",
        );
        yield* expectCode(
          service.configure({ ...configuration, readBackends: { calendar: "api" } }),
          "capability_unavailable",
        );
        yield* expectCode(
          service.configure({ ...configuration, account: "onecall", profileId: "profile-onecall" }),
          "capability_unavailable",
        );
        yield* service.configure({
          ...configuration,
          account: "onecall",
          profileId: "profile-onecall",
          readBackends: { slackSearch: "dom" },
        });
        yield* expectCode(
          service.run({ ...searchRequest, account: "onecall", cursor: "foreign-cursor" }),
          "invalid_cursor",
        );
      }),
    ),
);

it.live("blocks wrong environment, identity and human ownership before any data read", () =>
  withService((service, fixture) =>
    Effect.gen(function* () {
      yield* service.configure({
        ...configuration,
        slackApi: { ...configuration.slackApi!, environmentId: "another-host" },
      });
      yield* expectCode(service.run(searchRequest), "account_mismatch");
      expect(fixture.requests).toHaveLength(0);
      yield* service.configure(configuration);
      fixture.respond = () => Effect.succeed({ ok: false, code: "account_mismatch", status: 200 });
      yield* expectCode(service.run(searchRequest), "account_mismatch");
      expect(apiInputs(fixture).map((r) => r.operation)).toEqual(["identity"]);
      fixture.human = true;
      yield* expectCode(service.run(searchRequest), "browser_busy");
      fixture.human = false;
      fixture.unavailable = true;
      yield* expectCode(service.run(searchRequest), "browser_busy");
      expect(fixture.requests.filter((r) => r.operation === "workOpen")).toHaveLength(1);
    }),
  ),
);

it.live(
  "shares a single authentication hold across concurrent reads and requires explicit resume",
  () =>
    withService((service, fixture) =>
      Effect.gen(function* () {
        fixture.respond = () => Effect.succeed({ ok: false, code: "auth_required", status: 401 });
        const results = yield* Effect.all(
          [service.run(searchRequest), service.run(searchRequest)],
          { concurrency: "unbounded" },
        );
        expect(results.map((r) => r.state)).toEqual(["auth_required", "auth_required"]);
        expect(results.map((r) => r.notify)).toEqual([true, false]);
        expect(apiInputs(fixture)).toHaveLength(1);
        expect(results[0]!.authEpisode).toBe(results[1]!.authEpisode);
        expect(results[0]!.backend).toBe("api");
        expect(results[0]!.coverage).toBeUndefined();
        fixture.respond = (input) =>
          Effect.succeed(
            input.operation === "identity"
              ? { ok: true, items: [], more: false }
              : { ok: true, items: [item(1)], more: false },
          );
        const resumed = yield* service.run({
          operation: "resume",
          account: "verato",
          app: "slack",
        });
        expect(resumed).toMatchObject({ backend: "api", state: "ready", tabId: "private-tab" });
        expect(fixture.requests.filter((r) => r.operation === "workOpen")).toHaveLength(1);
        expect(fixture.requests.some((r) => r.operation === "evaluate")).toBe(false);
        expect(apiInputs(fixture).map((r) => r.operation)).toEqual(["identity", "identity"]);
        expect((yield* service.run(searchRequest)).state).toBe("ready");
      }),
    ),
);

it.live(
  "resume preserves the API hold until identity is verified and respects human ownership",
  () =>
    withService((service, fixture) =>
      Effect.gen(function* () {
        const resume: Request = { operation: "resume", account: "verato", app: "slack" };
        fixture.respond = () => Effect.succeed({ ok: false, code: "auth_required", status: 401 });
        const held = yield* service.run(searchRequest);
        fixture.human = true;
        yield* expectCode(service.run(resume), "browser_busy");
        expect(fixture.requests.some((r) => r.operation === "navigate")).toBe(false);
        fixture.human = false;
        const stillHeld = yield* service.run(resume);
        expect(stillHeld).toMatchObject({
          state: "auth_required",
          backend: "api",
          notify: false,
          authEpisode: held.authEpisode,
        });
        fixture.respond = () =>
          Effect.succeed({ ok: false, code: "account_mismatch", status: 200 });
        yield* expectCode(service.run(resume), "account_mismatch");
        expect((yield* service.run(searchRequest)).state).toBe("auth_required");
        expect(fixture.requests.filter((r) => r.operation === "workOpen")).toHaveLength(1);
        expect(fixture.requests.some((r) => r.operation === "evaluate")).toBe(false);
      }),
    ),
);

it.live("origin or identity changes invalidate references and cursors before returning data", () =>
  withService((service, fixture) =>
    Effect.gen(function* () {
      const successful = fixture.respond;
      for (const code of ["account_mismatch", "origin_changed"] as const) {
        fixture.respond = successful;
        const first = yield* service.run(searchRequest);
        fixture.respond = () => Effect.succeed({ ok: false, code, status: 200 });
        yield* expectCode(service.run(searchRequest), code);
        fixture.respond = successful;
        const calls = fixture.requests.length;
        yield* expectCode(
          service.run({ ...searchRequest, cursor: first.cursor! }),
          "invalid_cursor",
        );
        yield* expectCode(
          service.run({
            operation: "slackRead",
            account: "verato",
            messageRef: first.items[0]!.ref,
          }),
          "invalid_reference",
        );
        expect(fixture.requests).toHaveLength(calls);
      }
    }),
  ),
);

it.live("returns API permission errors without invoking DOM or authentication", () =>
  withService((service, fixture) =>
    Effect.gen(function* () {
      fixture.respond = () => Effect.succeed({ ok: false, code: "permission_denied", status: 403 });
      yield* expectCode(service.run(searchRequest), "permission_denied");
      expect(
        fixture.requests.some((r) => r.operation === "evaluate" || r.operation === "navigate"),
      ).toBe(false);
      expect(apiInputs(fixture)).toHaveLength(1);
    }),
  ),
);

it.live("retries rate-limited reads finitely and reverifies identity before the next request", () =>
  withService((service, fixture) =>
    Effect.gen(function* () {
      fixture.respond = (input) =>
        Effect.succeed(
          input.operation === "identity"
            ? { ok: true, items: [], more: false }
            : { ok: false, code: "rate_limited", status: 429, retryAfterMs: 0 },
        );
      yield* expectCode(service.run(searchRequest), "rate_limited");
      expect(apiInputs(fixture).filter((r) => r.operation === "search")).toHaveLength(3);
      expect(apiInputs(fixture).filter((r) => r.operation === "identity")).toHaveLength(3);
    }),
  ),
);

it.live(
  "bounds page count and output, rejects incompatible responses and redacts returned text",
  () =>
    withService((service, fixture) =>
      Effect.gen(function* () {
        fixture.respond = (input) =>
          Effect.succeed(
            input.operation === "identity"
              ? { ok: true, items: [], more: false }
              : {
                  ok: true,
                  items: [item(input.page ?? 1, "Bearer fixture-credential")],
                  more: true,
                  nextPage: (input.page ?? 1) + 1,
                },
          );
        const result = yield* service.run({ ...searchRequest, limit: 100 });
        expect(result.partial).toBe(true);
        expect(result.cursor).toBeDefined();
        expect(apiInputs(fixture).filter((r) => r.operation === "search")).toHaveLength(5);
        expect(JSON.stringify(result)).not.toContain("fixture-credential");
        fixture.respond = () =>
          Effect.succeed({ unexpected: "private-fixture" } as unknown as SlackPageResult);
        yield* expectCode(service.run(searchRequest), "response_incompatible");
      }),
    ),
);

it.live("interrupting a read prevents new pages and releases its queue permit", () =>
  withService((service, fixture) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      fixture.respond = (input) =>
        input.operation === "identity"
          ? Effect.succeed({ ok: true, items: [], more: false })
          : Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ ok: true as const, items: [item(1)], more: true, nextPage: 2 }),
            );
      const running = yield* service.run({ ...searchRequest, limit: 100 }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      expect(apiInputs(fixture).filter((r) => r.operation === "search")).toHaveLength(1);
      fixture.respond = () => Effect.succeed({ ok: true, items: [], more: false });
      const fresh = yield* service.run(searchRequest);
      expect(fresh.state).toBe("ready");
    }),
  ),
);

it.live("exposes API reads and typed failures through the actual MCP toolkit and service", () =>
  withService((service, fixture) => {
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      clientCapabilities: {},
      clientInfo: { name: "fixture", version: "1" },
      protocolVersion: "2025-06-18",
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
      getClient: Effect.die("unused fixture"),
    });
    const layer = toolkitRegistration(WorkBrowserToolkit, Handlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(AccessTestkit.liveThreadsLayer),
      Layer.provide(Layer.succeed(WorkBrowser.WorkBrowser, service)),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const response = yield* server.callTool({
        name: "work_slack_search",
        arguments: { account: "verato", query: "fixture", limit: 1 },
      });
      expect(response.isError).not.toBe(true);
      const contents = response.content
        .filter((value) => value.type === "text")
        .map((value) => value.text)
        .join("");
      const result = JSON.parse(contents) as Result;
      expect(result.backend).toBe("api");
      expect(result.cursor).toBeDefined();
      const read = yield* server.callTool({
        name: "work_slack_read",
        arguments: { account: "verato", messageRef: result.items[0]!.ref },
      });
      expect(read.isError).not.toBe(true);
      fixture.respond = () => Effect.succeed({ ok: false, code: "permission_denied", status: 403 });
      const failed = yield* server.callTool({
        name: "work_slack_search",
        arguments: { account: "verato", query: "fixture" },
      });
      expect(failed.isError).toBe(true);
      const error = failed.content
        .filter((value) => value.type === "text")
        .map((value) => value.text)
        .join("");
      expect(error).toContain("permission_denied");
      expect(error).toContain('"api"');
      expect(error).toContain("403");
    }).pipe(Effect.provide(layer), Effect.provideService(McpSchema.McpServerClient, client));
  }),
);

it.live(
  "invalidates references and continuations after identity configuration changes and restart",
  () =>
    withService((service, fixture) =>
      Effect.gen(function* () {
        const first = yield* service.run(searchRequest);
        const restarted = yield* fixture.restart();
        yield* expectCode(
          restarted.run({ ...searchRequest, cursor: first.cursor! }),
          "invalid_cursor",
        );
        yield* expectCode(
          restarted.run({
            operation: "slackRead",
            account: "verato",
            messageRef: first.items[0]!.ref,
          }),
          "invalid_reference",
        );
        expect((yield* restarted.run(searchRequest)).backend).toBe("api");
        yield* service.configure({
          ...configuration,
          slackApi: { ...configuration.slackApi!, userId: "UNEW" },
        });
        yield* expectCode(
          service.run({ ...searchRequest, cursor: first.cursor! }),
          "invalid_cursor",
        );
        yield* expectCode(
          service.run({
            operation: "slackRead",
            account: "verato",
            messageRef: first.items[0]!.ref,
          }),
          "invalid_reference",
        );
      }),
    ),
);

it.live("reads paginated thread replies without merging unrelated roots", () =>
  withService((service, fixture) =>
    Effect.gen(function* () {
      const first = yield* service.run(searchRequest);
      fixture.respond = (input) =>
        Effect.succeed(
          input.operation === "identity"
            ? { ok: true, items: [], more: false }
            : {
                ok: true,
                items: [inThread(item(input.cursor ? 2 : 1), item(1).id)],
                more: !input.cursor,
                ...(!input.cursor ? { cursor: "fixture-page-2" } : {}),
              },
        );
      const thread = yield* service.run({
        operation: "slackRead",
        account: "verato",
        messageRef: first.items[0]!.ref,
      });
      expect(thread.items).toHaveLength(2);
      expect(thread.partial).toBe(false);
      expect(thread.coverage).toBe("thread");
      expect(
        apiInputs(fixture)
          .filter((r) => r.operation === "thread")
          .map((r) => r.cursor),
      ).toEqual([undefined, "fixture-page-2"]);
      fixture.respond = (input) =>
        Effect.succeed(
          input.operation === "identity"
            ? { ok: true, items: [], more: false }
            : { ok: true, items: [{ ...item(2) }], more: false },
        );
      yield* expectCode(
        service.run({ operation: "slackRead", account: "verato", messageRef: first.items[0]!.ref }),
        "response_incompatible",
      );
    }),
  ),
);

it.live("orders newest-first replies pages and continues with older replies", () =>
  withService((service, fixture) =>
    Effect.gen(function* () {
      // Shape observed from conversations.replies: every page repeats the root, pages run
      // newest to oldest and each page is ascending.
      const rootTs = "1791921504.084689";
      const message = (ts: string) => ({ ...item(1), id: ts, timestamp: ts, sourceUrl: "" });
      const root = inThread(
        {
          ...message(rootTs),
          sourceUrl: "https://work.slack.com/archives/CGENERAL/p1791921504084689",
        },
        rootTs,
      );
      const reply = (index: number) => {
        const ts = `${1791921600 + index}.000100`;
        return inThread(
          {
            ...message(ts),
            sourceUrl: `https://work.slack.com/archives/CGENERAL/p${ts.replace(".", "")}`,
          },
          rootTs,
        );
      };
      const pages: Record<string, { items: ReturnType<typeof reply>[]; next?: string }> = {
        start: { items: [root, reply(9), reply(10)], next: "c1" },
        c1: { items: [root, reply(7), reply(8)], next: "c2" },
        c2: { items: [reply(5), reply(6)], next: "c3" },
        c3: { items: [reply(3), reply(4)], next: "c4" },
        c4: { items: [reply(1), reply(2)], next: "c5" },
        c5: { items: [reply(0)] },
      };
      fixture.respond = (input) =>
        Effect.succeed(
          input.operation === "identity"
            ? { ok: true, items: [], more: false }
            : input.operation === "search"
              ? { ok: true, items: [reply(4)], more: false }
              : (() => {
                  const page = pages[input.cursor ?? "start"]!;
                  return {
                    ok: true as const,
                    items: page.items,
                    more: page.next !== undefined,
                    ...(page.next ? { cursor: page.next } : {}),
                  };
                })(),
        );
      const found = yield* service.run(searchRequest);
      const first = yield* service.run({
        operation: "slackRead",
        account: "verato",
        messageRef: found.items[0]!.ref,
      });
      const ascending = [rootTs, ...Array.from({ length: 10 }, (_, i) => reply(i + 1).id)];
      expect(first.items.map((entry) => entry.timestamp)).toEqual(ascending);
      expect(first.items[1]!.sourceUrl).toBe(reply(1).sourceUrl);
      expect(first).toMatchObject({ partial: true, coverage: "thread" });
      expect(first.cursor).toBeDefined();
      const rest = yield* service.run({
        operation: "slackRead",
        account: "verato",
        messageRef: found.items[0]!.ref,
        cursor: first.cursor!,
      });
      expect(rest.items.map((entry) => entry.timestamp)).toEqual([reply(0).id]);
      expect(rest.partial).toBe(false);
      const all = [...first.items, ...rest.items].map((entry) => entry.ref);
      expect(new Set(all).size).toBe(12);
      expect(
        apiInputs(fixture)
          .filter((r) => r.operation === "thread")
          .map((r) => r.cursor),
      ).toEqual([undefined, "c1", "c2", "c3", "c4", "c5"]);
    }),
  ),
);

import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as WorkBrowser from "../../../workBrowser/WorkBrowser.ts";
import { WorkBrowserError } from "../../../workBrowser/schema.ts";
import { toolkitRegistration } from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as AccessTestkit from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { WorkBrowserToolkit } from "./tools.ts";

const scope = {
  environmentId: EnvironmentId.make("work-tools-test"),
  requestNamespace: "work-tools",
  issuedAt: 1,
  capabilities: new Set(["preview"] as const),
  client: undefined,
  thread: {
    threadId: ThreadId.make("work-tools-thread"),
    providerSessionId: "work-tools-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "exposes typed work tools, requires account, and keeps internal causes out of MCP responses",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const layer = toolkitRegistration(WorkBrowserToolkit, Handlers.layer).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(AccessTestkit.liveThreadsLayer),
          Layer.provide(
            Layer.mock(WorkBrowser.WorkBrowser)({
              run: () =>
                Effect.suspend(() => {
                  calls++;
                  return Effect.fail(
                    new WorkBrowserError({
                      code: "ui_changed",
                      cause: "sensitive-internal-detail",
                    }),
                  );
                }),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          expect(server.tools).toHaveLength(10);
          expect(server.tools.map(({ tool }) => tool.name)).toContain("work_outlook_send");
          const missing = yield* Effect.exit(
            server.callTool({ name: "work_slack_search", arguments: { query: "hello" } }),
          );
          expect(
            missing._tag === "Failure" || (missing._tag === "Success" && missing.value.isError),
          ).toBe(true);
          expect(calls).toBe(0);
          const failed = yield* server.callTool({
            name: "work_slack_search",
            arguments: { account: "verato", query: "hello" },
          });
          expect(calls).toBe(1);
          expect(JSON.stringify(failed)).not.toContain("sensitive-internal-detail");
          expect(JSON.stringify(failed)).toContain("ui_changed");
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(Invocation.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      }),
    ),
);

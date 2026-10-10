import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as WorkBrowser from "./WorkBrowser.ts";
import { Result, WorkBrowserError } from "./schema.ts";
const isWorkBrowserError = Schema.is(WorkBrowserError);
const isResult = Schema.is(Result);

const verato = {
  account: "verato",
  profileId: "profile-verato",
  slackUrl: "verato",
  accountEmail: "lorenzo@verato.example",
};
const veratoHome = "https://app.slack.com/client/EVERATO";
const onecall = {
  ...verato,
  account: "onecall",
  profileId: "profile-onecall",
  slackUrl: "https://app.slack.com/client/TONECALL",
  accountEmail: "lorenzo@onecall.example",
};
const scope = {
  environmentId: EnvironmentId.make("work-browser-test"),
  requestNamespace: "test",
  issuedAt: 1,
  capabilities: new Set(["preview"] as const),
  client: undefined,
  thread: {
    threadId: ThreadId.make("work-thread"),
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

it.effect(
  "keeps work accounts separate, shares each login, holds expired auth, and never replays an uncertain send",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Array<Broker.PreviewAutomationInvokeInput> = [];
        const pages = new Map<
          string,
          { url: string; profile: string; searchActive: boolean; query: string; submitted: boolean }
        >();
        let expired = true;
        let wrongWorkspace = false;
        let crashAfterClick = false;
        let sendClicks = 0;
        const broker = Layer.mock(Broker.PreviewAutomationBroker)({
          invoke: <A>(request: Broker.PreviewAutomationInvokeInput) =>
            Effect.suspend(() => {
              requests.push(request);
              const input = request.input as Record<string, string>;
              let page = request.tabId ? pages.get(request.tabId) : undefined;
              let value: unknown = {};
              const redirect = (url: string) =>
                url === "https://verato.slack.com" ? veratoHome : url;
              if (request.operation === "workOpen") {
                const tabId = PreviewTabId.make(`work-tab-${pages.size}`);
                page = {
                  url: redirect(input.url!),
                  profile: input.profileId!,
                  searchActive: false,
                  query: "",
                  submitted: false,
                };
                pages.set(tabId, page);
                value = { tabId, available: true };
              } else if (request.operation === "status")
                value = { available: true, tabId: request.tabId };
              else if (request.operation === "navigate") {
                page!.url = redirect(input.url!);
                page!.searchActive = false;
                page!.query = "";
                page!.submitted = false;
              } else if (request.operation === "click" && Number(input.x) === 9)
                page!.searchActive = true;
              else if (request.operation === "click" && Number(input.x) === 17) sendClicks++;
              else if (request.operation === "type" && input.text && page!.url.includes("outlook."))
                page!.query = page!.searchActive ? input.text : "";
              else if (request.operation === "press" && input.key === "Enter")
                page!.submitted = page!.searchActive && page!.query.length > 0;
              else if (request.operation === "evaluate") {
                if (crashAfterClick && input.expression!.includes(',"sent",'))
                  return Effect.die("connection lost after Send");
                const rows =
                  input.expression!.includes(',"rows",') ||
                  input.expression!.includes(',"searchRows",');
                const outlook = page!.url.includes("outlook.");
                value = {
                  state: expired
                    ? "auth_required"
                    : outlook && rows && !page!.submitted
                      ? "ui_changed"
                      : "ready",
                  url: wrongWorkspace ? "https://app.slack.com/client/TOTHER" : page!.url,
                  account:
                    page!.profile === verato.profileId ? verato.accountEmail : onecall.accountEmail,
                  locator: input.expression!.includes(',"sendButton",')
                    ? "[data-work-browser-send]"
                    : outlook && input.expression!.includes(',"searchInput",')
                      ? "[data-work-browser-search]"
                      : "[data-work-browser-control]",
                  point: input.expression!.includes('"locator":"[data-work-browser-send]"')
                    ? { x: 17, y: 19 }
                    : input.expression!.includes('"locator":"[data-work-browser-search]"')
                      ? { x: 9, y: 1 }
                      : { x: 1, y: 1 },
                  ids: ["message-1"],
                  more: rows,
                  items: rows
                    ? [
                        {
                          id: "message-1",
                          ref: "",
                          kind: outlook ? "mail" : "message",
                          text: "A visible message",
                          author: "Person",
                          subject: null,
                          sourceUrl: `${page!.url.split("/search")[0]}/CGENERAL`,
                          timestamp: null,
                        },
                      ]
                    : [],
                };
              }
              return Effect.succeed(value as A);
            }),
        });
        const dependencies = Layer.mergeAll(
          broker,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-work-browser-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        const program = Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          for (const account of [verato, onecall])
            yield* fs.makeDirectory(
              path.join(config.stateDir, "server-browser", "profiles", account.profileId),
              { recursive: true },
            );
          const service = yield* WorkBrowser.WorkBrowser;
          const configured = yield* service.configure(verato);
          expect(configured.slackUrl).toBe("https://verato.slack.com");
          expect(configured.outlookUrl).toBe("https://outlook.office.com/mail/");
          yield* service.configure(onecall);
          for (const slackUrl of [
            "app",
            "https://accounts.slack.com",
            "https://verato.slack.com.evil.example",
            "https://verato.slack.com/unrelated",
            "http://verato.slack.com",
            "https://user@verato.slack.com",
          ]) {
            const invalid = yield* Effect.result(service.configure({ ...verato, slackUrl }));
            expect(invalid._tag).toBe("Failure");
            if (invalid._tag === "Failure" && isWorkBrowserError(invalid.failure))
              expect(invalid.failure.code).toBe("invalid_configuration");
          }
          const reuse = yield* Effect.result(
            service.configure({ ...onecall, profileId: verato.profileId }),
          );
          expect(reuse._tag).toBe("Failure");
          const unsafeProfile = yield* Effect.result(
            service.configure({ ...verato, profileId: "." }),
          );
          expect(unsafeProfile._tag).toBe("Failure");
          const initialLogin = yield* service.run({
            operation: "status",
            account: "verato",
            app: "slack",
          });
          expect(initialLogin.state).toBe("auth_required");
          expect(initialLogin.notify).toBe(true);
          const beforeInitialHold = requests.length;
          const waiting = yield* service.run({
            operation: "status",
            account: "verato",
            app: "slack",
          });
          expect(waiting.notify).toBe(false);
          expect(requests.length).toBe(beforeInitialHold);
          expired = false;
          yield* service.run({ operation: "resume", account: "verato", app: "slack" });
          const first = yield* service.run({
            operation: "slackSearch",
            account: "verato",
            query: "hello",
          });
          expect(first.items).toHaveLength(1);
          const toolbar = requests.findIndex(
            (request) =>
              request.operation === "evaluate" &&
              (request.input as { expression: string }).expression.includes(',"searchButton",'),
          );
          expect(requests[toolbar - 1]!.input).toMatchObject({ key: "Escape" });
          const typed = requests.filter((request) => request.operation === "type");
          expect(typed.at(-1)!.input).toMatchObject({ text: "hello", clear: false });
          expect(
            requests.some(
              (request) =>
                request.operation === "press" &&
                (request.input as { key: string }).key === "ControlOrMeta+A",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.operation === "evaluate" &&
                (request.input as { expression: string }).expression.includes(',"searchSubmit",'),
            ),
          ).toBe(true);
          const beforeWrongAccount = requests.length;
          const wrong = yield* Effect.result(
            service.run({
              operation: "slackRead",
              account: "onecall",
              messageRef: first.items[0]!.ref,
            }),
          );
          expect(wrong._tag).toBe("Failure");
          expect(requests.length).toBe(beforeWrongAccount);
          yield* service.run({ operation: "status", account: "onecall", app: "outlook" });
          yield* service.run({ operation: "status", account: "verato", app: "slack" }).pipe(
            Effect.provideService(Invocation.McpInvocationContext, {
              ...scope,
              thread: {
                ...scope.thread,
                threadId: ThreadId.make("another-work-thread"),
                providerSessionId: "agent-b",
              },
            }),
          );
          const profiles = requests
            .filter((request) => request.operation === "workOpen")
            .map((request) => (request.input as { profileId: string }).profileId);
          expect(profiles).toEqual([verato.profileId, onecall.profileId]);
          expect(requests.at(-1)!.scope.thread.threadId).toBe(scope.thread.threadId);
          expect(requests.at(-1)!.scope.thread.providerSessionId).not.toBe("agent-b");
          expect(
            (requests.find((request) => request.operation === "workOpen")!.input as { url: string })
              .url,
          ).toBe("https://verato.slack.com");
          yield* service.configure(verato);
          const reloaded = yield* WorkBrowser.WorkBrowser.pipe(
            Effect.provide(Layer.fresh(WorkBrowser.layer)),
          );
          yield* reloaded.run({ operation: "status", account: "verato", app: "slack" });
          expect(
            (
              requests.findLast((request) => request.operation === "workOpen")!.input as {
                url: string;
              }
            ).url,
          ).toBe(veratoHome);
          wrongWorkspace = true;
          const mismatch = yield* Effect.result(
            reloaded.run({ operation: "status", account: "verato", app: "slack" }),
          );
          expect(mismatch._tag).toBe("Failure");
          if (mismatch._tag === "Failure" && isWorkBrowserError(mismatch.failure))
            expect(mismatch.failure.code).toBe("account_mismatch");
          wrongWorkspace = false;

          const mail = yield* service.run({
            operation: "mailSearch",
            account: "verato",
            query: "expected query",
          });
          expect(mail.items).toHaveLength(1);
          expect(mail.items[0]!.kind).toBe("mail");

          expired = true;
          const held = yield* service.run({ operation: "status", account: "verato", app: "slack" });
          expect(held.state).toBe("auth_required");
          expect(held.notify).toBe(true);
          const beforeHold = requests.length;
          const heldAgain = yield* service.run({
            operation: "slackSearch",
            account: "verato",
            query: "no login retry",
          });
          expect(heldAgain.authEpisode).toBe(held.authEpisode);
          expect(heldAgain.notify).toBe(false);
          expect(requests.length).toBe(beforeHold);
          expired = false;
          yield* service.run({ operation: "resume", account: "verato", app: "slack" });

          const send = {
            operation: "slackSend" as const,
            account: "verato",
            channelUrl: `${veratoHome}/CGENERAL`,
            text: "An authorized fixture message",
            operationId: "send-1",
          };
          crashAfterClick = true;
          const crashed = yield* Effect.exit(service.run(send));
          expect(crashed._tag).toBe("Failure");
          expect(sendClicks).toBe(1);
          const beforeReplay = requests.length;
          const restarted = yield* WorkBrowser.WorkBrowser.pipe(
            Effect.provide(Layer.fresh(WorkBrowser.layer)),
          );
          const replay = yield* restarted.run(send);
          expect(replay.state).toBe("send_unknown");
          expect(sendClicks).toBe(1);
          expect(requests.length).toBe(beforeReplay);
          const conflict = yield* Effect.result(
            service.run({ ...send, text: "Different content" }),
          );
          expect(conflict._tag).toBe("Failure");
          if (conflict._tag === "Failure" && isWorkBrowserError(conflict.failure))
            expect(conflict.failure.code).toBe("operation_conflict");
          crashAfterClick = false;
          const confirmed = yield* service.run({ ...send, operationId: "send-2" });
          expect(confirmed.state).toBe("confirmed");
          expect(sendClicks).toBe(2);
          const replayConfirmed = yield* service.run({ ...send, operationId: "send-2" });
          expect(replayConfirmed.state).toBe("confirmed");
          expect(sendClicks).toBe(2);
          expect(isResult(confirmed)).toBe(true);
        });
        yield* program.pipe(
          Effect.provide(WorkBrowser.layer.pipe(Layer.provideMerge(dependencies))),
          Effect.provideService(Invocation.McpInvocationContext, scope),
        );
      }),
    ),
  15_000,
);

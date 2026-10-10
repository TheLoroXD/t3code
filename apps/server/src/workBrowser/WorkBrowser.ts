import {
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewTabId,
  type PreviewAutomationUnavailableError,
  type PreviewAutomationOperation,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import { pageProgram } from "./dom.ts";
import {
  Configuration,
  PageObservation,
  Result,
  WorkBrowserError,
  type App,
  type Request,
} from "./schema.ts";

export class WorkBrowser extends Context.Service<
  WorkBrowser,
  {
    readonly configure: (input: Configuration) => Effect.Effect<Configuration, WorkBrowserError>;
    readonly run: (
      request: Request,
    ) => Effect.Effect<
      Result,
      WorkBrowserError | PreviewAutomationUnavailableError,
      Invocation.McpInvocationContext
    >;
  }
>()("t3/workBrowser/WorkBrowser") {}

const StoredConfiguration = Schema.Struct({
  ...Configuration.fields,
  slackWorkspaceId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[TE][A-Z0-9]+$/))),
});
const AccountsJson = Schema.fromJsonString(Schema.Array(StoredConfiguration));
const ReceiptJson = Schema.fromJsonString(
  Schema.Struct({ fingerprint: Schema.String, result: Result }),
);
const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const encodeAccounts = Schema.encodeEffect(AccountsJson);
const encodeReceipt = Schema.encodeEffect(ReceiptJson);
const decodeAccounts = Schema.decodeUnknownEffect(AccountsJson);
const decodeReceipt = Schema.decodeUnknownEffect(ReceiptJson);
const decodePage = Schema.decodeUnknownEffect(PageObservation);
const isWorkBrowserError = Schema.is(WorkBrowserError);
const fail = (code: WorkBrowserError["code"]) => new WorkBrowserError({ code });
const storageError = (cause: unknown) => new WorkBrowserError({ code: "storage_failed", cause });
const emailPattern = /^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i;
const slackNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const reservedSlackNames = new Set(["app", "accounts", "api", "www", "status"]);
const outlookHosts = new Set([
  "outlook.office.com",
  "outlook.office365.com",
  "outlook.cloud.microsoft",
]);

function safeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}
function workspace(url: URL): string | undefined {
  return /^\/client\/([TE][A-Z0-9]+)(?:\/|$)/.exec(url.pathname)?.[1];
}
function belongsTo(app: App, value: string, slackWorkspaceId: string | undefined): boolean {
  const url = safeUrl(value);
  if (!url) return false;
  if (app === "outlook") return outlookHosts.has(url.hostname);
  return (
    url.hostname === "app.slack.com" &&
    slackWorkspaceId !== undefined &&
    workspace(url) === slackWorkspaceId
  );
}

const make = Effect.gen(function* () {
  const broker = yield* Broker.PreviewAutomationBroker;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const directory = path.join(config.stateDir, "work-browser");
  const accountsPath = path.join(directory, "accounts.json");
  // ponytail: one queue for browser workflows; use per-account queues if throughput requires it.
  const queue = Semaphore.makeUnsafe(1);
  const tabs = new Map<
    string,
    { tabId: PreviewTabId; scope: Invocation.McpThreadInvocationScope }
  >();
  const blocked = new Map<
    string,
    {
      id: string;
      tabId: PreviewTabId;
      threadId: typeof Result.Type.authThreadId;
      notified: boolean;
    }
  >();
  const references = new Map<
    string,
    { identity: string; app: App; id: string; sourceUrl: string; searchUrl: string; query?: string }
  >();
  const hash = (value: unknown) =>
    encodeJson(value).pipe(
      Effect.flatMap((encoded) => crypto.digest("SHA-256", new TextEncoder().encode(encoded))),
      Effect.map((bytes) =>
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
      Effect.mapError(storageError),
    );
  const load = Effect.gen(function* () {
    if (!(yield* fs.exists(accountsPath)))
      return [] as readonly (typeof StoredConfiguration.Type)[];
    return yield* fs.readFileString(accountsPath).pipe(Effect.flatMap(decodeAccounts));
  }).pipe(Effect.mapError(storageError));
  const save = (filePath: string, contents: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(directory, 0o700);
      yield* writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      yield* fs.chmod(filePath, 0o600);
    }).pipe(Effect.mapError(storageError));
  const validate = (input: Configuration) =>
    Effect.gen(function* () {
      const slack = safeUrl(
        slackNamePattern.test(input.slackUrl)
          ? `https://${input.slackUrl.toLowerCase()}.slack.com`
          : input.slackUrl,
      );
      const outlook = safeUrl(input.outlookUrl ?? "https://outlook.office.com/mail/");
      const slackName = slack?.hostname.match(/^([a-z0-9-]+)\.slack\.com$/)?.[1];
      const slackId = slack ? workspace(slack) : undefined;
      const profile = yield* fs
        .stat(
          path.join(
            config.stateDir,
            "server-browser",
            "profiles",
            encodeURIComponent(input.profileId),
          ),
        )
        .pipe(Effect.orElseSucceed(() => undefined));
      if (
        !slack ||
        (!(slack.hostname === "app.slack.com" && slackId) &&
          !(
            slackName &&
            slackNamePattern.test(slackName) &&
            !reservedSlackNames.has(slackName) &&
            slack.pathname === "/" &&
            !slack.search &&
            !slack.hash
          )) ||
        !outlook ||
        !outlookHosts.has(outlook.hostname) ||
        !/^\/mail(?:\/|$)/.test(outlook.pathname) ||
        input.profileId === INCOGNITO_BROWSER_PROFILE_ID ||
        input.profileId === "." ||
        input.profileId === ".." ||
        profile?.type !== "Directory" ||
        !emailPattern.test(input.accountEmail)
      )
        return yield* fail("invalid_configuration");
      return {
        ...input,
        slackUrl: slackId ? `${slack.origin}/client/${slackId}` : slack.origin,
        outlookUrl: `${outlook.origin}${outlook.pathname}`,
        accountEmail: input.accountEmail.toLowerCase(),
      };
    });
  const configure = (input: Configuration) =>
    queue.withPermit(
      Effect.gen(function* () {
        const value = yield* validate(input);
        const accounts = yield* load;
        if (
          accounts.some(
            (account) => account.account !== value.account && account.profileId === value.profileId,
          )
        )
          return yield* fail("invalid_configuration");
        const previous = accounts.find((account) => account.account === value.account);
        const slackWorkspaceId =
          previous?.profileId === value.profileId &&
          previous.slackUrl === value.slackUrl &&
          previous.outlookUrl === value.outlookUrl &&
          previous.accountEmail === value.accountEmail
            ? previous.slackWorkspaceId
            : undefined;
        const updated = [
          ...accounts.filter((account) => account.account !== value.account),
          { ...value, ...(slackWorkspaceId ? { slackWorkspaceId } : {}) },
        ];
        yield* save(
          accountsPath,
          yield* encodeAccounts(updated).pipe(Effect.mapError(storageError)),
        );
        return value;
      }),
    );

  const run = (request: Request) =>
    queue.withPermit(
      Effect.gen(function* () {
        const scope = yield* Invocation.requireThreadMcpCapability("preview");
        const stored = (yield* load).find((account) => account.account === request.account);
        if (!stored) return yield* fail("configuration_required");
        const configuration = yield* validate(stored);
        let slackWorkspaceId =
          workspace(safeUrl(configuration.slackUrl)!) ?? stored.slackWorkspaceId;
        const slackHome = () =>
          slackWorkspaceId
            ? `https://app.slack.com/client/${slackWorkspaceId}`
            : configuration.slackUrl;
        const app: App =
          request.operation === "status" || request.operation === "resume"
            ? request.app
            : request.operation.startsWith("slack")
              ? "slack"
              : "outlook";
        const identity = yield* hash([
          configuration.account,
          configuration.profileId,
          configuration.slackUrl,
          configuration.outlookUrl,
          configuration.accountEmail,
        ]);
        const authKey = `${identity}:${app}`;
        const tabKey = `${scope.environmentId}:${authKey}`;
        // One private driver per account keeps Outlook's tab-local session between agent calls.
        const driverScope = {
          ...scope,
          thread: { ...scope.thread, providerSessionId: `work-browser:${identity}` },
        };
        let browserScope = tabs.get(tabKey)?.scope ?? driverScope;
        let tabId = tabs.get(tabKey)?.tabId;
        let searchUrl = app === "slack" ? slackHome() : configuration.outlookUrl;
        let searchQuery: string | undefined;
        const invoke = <A = unknown>(operation: PreviewAutomationOperation, input: unknown) =>
          broker
            .invoke<A>({ scope: browserScope, operation, input, ...(tabId ? { tabId } : {}) })
            .pipe(
              Effect.mapError(
                (cause) => new WorkBrowserError({ code: "browser_unavailable", cause }),
              ),
            );
        const result = (
          state: Result["state"],
          observation?: PageObservation,
          operationId?: string,
        ) =>
          Effect.gen(function* () {
            const episode = state === "auth_required" ? blocked.get(authKey) : undefined;
            const items: Array<(typeof Result.Type.items)[number]> = [];
            for (const item of (observation?.items ?? []).slice(
              0,
              "limit" in request ? (request.limit ?? 50) : 100,
            )) {
              const sourceUrl = item.sourceUrl ?? observation!.url;
              if (!belongsTo(app, sourceUrl, slackWorkspaceId)) continue;
              const ref = yield* hash([
                identity,
                app,
                item.id,
                sourceUrl,
                searchUrl,
                searchQuery ?? "",
              ]);
              references.set(ref, {
                identity,
                app,
                id: item.id,
                sourceUrl,
                searchUrl,
                ...(searchQuery ? { query: searchQuery } : {}),
              });
              if (references.size > 2000) references.delete(references.keys().next().value!);
              items.push({
                ref,
                kind: item.kind,
                text: item.text,
                author: item.author,
                subject: item.subject,
                sourceUrl,
                timestamp: item.timestamp,
              });
            }
            const notify = episode !== undefined && !episode.notified;
            if (episode) episode.notified = true;
            return {
              account: configuration.account,
              app,
              profileId: configuration.profileId,
              browserThreadId: browserScope.thread.threadId,
              ...((episode?.tabId ?? tabId) ? { tabId: (episode?.tabId ?? tabId)! } : {}),
              state,
              observedAt: DateTime.formatIso(yield* DateTime.now),
              items,
              partial: observation?.more ?? false,
              effects:
                app === "outlook"
                  ? ["Opening mail may mark it as read; composing may autosave a draft."]
                  : [],
              notify,
              authEpisode: episode?.id ?? null,
              ...(episode?.threadId ? { authThreadId: episode.threadId } : {}),
              ...(operationId ? { operationId } : {}),
            } satisfies Result;
          });
        const observe = (task: string, input: object = {}, wait = true) =>
          Effect.gen(function* () {
            const observation = yield* invoke("evaluate", {
              expression: pageProgram(app, task, {
                ...input,
                accountEmail: configuration.accountEmail,
              }),
            }).pipe(
              Effect.flatMap(decodePage),
              Effect.mapError((cause) =>
                isWorkBrowserError(cause)
                  ? cause
                  : new WorkBrowserError({ code: "ui_changed", cause }),
              ),
            );
            if (observation.state === "auth_required") {
              if (!blocked.has(authKey))
                blocked.set(authKey, {
                  id: yield* crypto.randomUUIDv4.pipe(Effect.mapError(storageError)),
                  tabId: tabId!,
                  threadId: browserScope.thread.threadId,
                  notified: false,
                });
              return yield* fail("auth_required");
            }
            if (
              observation.state === "account_mismatch" ||
              (app === "outlook" &&
                observation.account !== null &&
                observation.account !== configuration.accountEmail)
            )
              return yield* fail("account_mismatch");
            if (
              observation.state !== "ready" ||
              (app === "outlook" && observation.account === null)
            )
              return yield* fail("ui_changed");
            if (app === "slack" && slackWorkspaceId === undefined) {
              // Resolve only after navigating the configured workspace through its normal SSO route.
              const url = safeUrl(observation.url);
              const resolved = url?.hostname === "app.slack.com" ? workspace(url) : undefined;
              if (!resolved) return yield* fail("account_mismatch");
              const accounts = yield* load;
              yield* save(
                accountsPath,
                yield* encodeAccounts(
                  accounts.map((account) =>
                    account.account === configuration.account
                      ? { ...account, slackWorkspaceId: resolved }
                      : account,
                  ),
                ).pipe(Effect.mapError(storageError)),
              );
              slackWorkspaceId = resolved;
              searchUrl = slackHome();
            }
            if (!belongsTo(app, observation.url, slackWorkspaceId))
              return yield* fail("account_mismatch");
            return observation;
          }).pipe(
            Effect.retry({
              while: (error) => error.code === "ui_changed",
              times: wait ? 20 : 0,
              schedule: Schedule.spaced("200 millis"),
            }),
          );
        const control = (task: string, input: object = {}) =>
          observe(task, input).pipe(
            Effect.flatMap((page) =>
              page.locator ? Effect.succeed(page.locator) : Effect.fail(fail("ui_changed")),
            ),
          );
        const type = (locator: string, text: string) =>
          Effect.gen(function* () {
            // Slack's Quill editor drops text written with locator.fill().
            yield* invoke("type", { locator, text: "", clear: false });
            yield* invoke("press", { key: "ControlOrMeta+A" });
            yield* invoke("press", { key: "Delete" });
            yield* invoke("type", { locator, text, clear: false });
          });
        const fill = (task: string, text: string) =>
          control(task).pipe(Effect.flatMap((locator) => type(locator, text)));
        const clickLocator = (locator: string) =>
          Effect.gen(function* () {
            // Slack's locator click stalls; retain a real mouse click after DOM hit-testing.
            const page = yield* observe("clickPoint", { locator }, false);
            if (!page.point) return yield* fail("ui_changed");
            yield* invoke("click", page.point);
          });
        const click = (task: string, input: object = {}) =>
          control(task, input).pipe(Effect.flatMap(clickLocator));
        const navigate = (url: string) =>
          invoke("navigate", { url, waitUntil: "domcontentloaded" });
        const search = (query: string) =>
          Effect.gen(function* () {
            searchQuery = query;
            if (app === "slack") {
              yield* click("searchButton");
            } else {
              searchUrl = configuration.outlookUrl;
              yield* navigate(searchUrl);
            }
            const locator = yield* control("searchInput");
            yield* type(locator, query);
            if (app === "slack") yield* click("searchSubmit", { query });
            else yield* invoke("press", { key: "Enter" });
            return yield* observe("searchRows", { query });
          });

        const sending = request.operation === "slackSend" || request.operation === "mailSend";
        const fingerprint = sending
          ? yield* hash([
              identity,
              request.operation,
              request.operationId,
              request.operation === "slackSend" ? request.channelUrl : request.to,
              request.operation === "mailSend" ? request.subject : null,
              request.text,
            ])
          : undefined;
        const receiptPath = sending
          ? path.join(
              directory,
              `${yield* hash([configuration.account, request.operationId])}.json`,
            )
          : undefined;
        if (receiptPath && (yield* fs.exists(receiptPath).pipe(Effect.mapError(storageError)))) {
          const receipt = yield* fs
            .readFileString(receiptPath)
            .pipe(Effect.flatMap(decodeReceipt), Effect.mapError(storageError));
          if (receipt.fingerprint !== fingerprint) return yield* fail("operation_conflict");
          return receipt.result;
        }
        if (request.operation === "slackRead" || request.operation === "mailRead") {
          const reference = references.get(request.messageRef);
          if (!reference || reference.identity !== identity || reference.app !== app)
            return yield* fail("invalid_reference");
        }
        if (blocked.has(authKey) && request.operation !== "resume")
          return yield* result("auth_required");

        const workflow = Effect.gen(function* () {
          if (tabId) {
            // A user may close a tab; never silently recover a tab after a send started.
            const status = yield* invoke<PreviewAutomationStatus>("status", {}).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            if (!status?.available) {
              tabs.delete(tabKey);
              tabId = undefined;
              browserScope = driverScope;
              if (request.operation === "resume") blocked.delete(authKey);
            }
          }
          if (!tabId) {
            const page = yield* invoke<PreviewAutomationStatus>("workOpen", {
              profileId: configuration.profileId,
              url: searchUrl,
              open: false,
              reuseExistingTab: false,
            });
            if (!page.tabId) return yield* fail("browser_unavailable");
            tabId = PreviewTabId.make(page.tabId);
            tabs.set(tabKey, { tabId, scope: browserScope });
          }
          if (request.operation === "resume") {
            // One explicit retry after the human finishes SSO. Other calls remain on hold.
            yield* navigate(searchUrl);
            const page = yield* observe("status");
            blocked.delete(authKey);
            return yield* result("ready", page);
          }
          yield* observe("status");
          switch (request.operation) {
            case "status":
              return yield* result("ready");
            case "slackSearch":
            case "mailSearch":
              return yield* result("ready", yield* search(request.query));
            case "slackRead":
            case "mailRead": {
              const reference = references.get(request.messageRef);
              if (!reference || reference.identity !== identity || reference.app !== app)
                return yield* fail("invalid_reference");
              searchUrl = reference.searchUrl;
              searchQuery = reference.query;
              if (app === "slack") {
                // Search snippets without a permalink cannot identify one thread reliably.
                if (
                  !/^\/client\/[TE][A-Z0-9]+\/C[A-Z0-9]+/.test(
                    safeUrl(reference.sourceUrl)?.pathname ?? "",
                  )
                )
                  return yield* fail("invalid_reference");
                yield* navigate(reference.sourceUrl);
                return yield* result("ready", yield* observe("message", { id: reference.id }));
              }
              if (reference.query) yield* search(reference.query);
              else yield* navigate(reference.searchUrl);
              yield* click("mailRow", { id: reference.id });
              return yield* result("ready", yield* observe("mailBody", { id: reference.id }));
            }
            case "calendar": {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date))
                return yield* fail("invalid_configuration");
              const [year, month, day] = request.date.split("-");
              const valid = yield* Effect.try({
                try: () => {
                  const formatter = new Intl.DateTimeFormat("en-US", {
                    timeZone: request.timeZone,
                  });
                  return (
                    formatter.resolvedOptions().timeZone.length > 0 &&
                    DateTime.formatIsoDate(DateTime.makeUnsafe(`${request.date}T00:00:00Z`)) ===
                      request.date
                  );
                },
                catch: () => fail("invalid_configuration"),
              });
              if (!valid) return yield* fail("invalid_configuration");
              yield* navigate(
                `${safeUrl(configuration.outlookUrl)!.origin}/calendar/view/day/${year}/${month}/${day}`,
              );
              return yield* result(
                "ready",
                yield* observe("calendar", { date: request.date, timeZone: request.timeZone }),
              );
            }
            case "slackSend":
            case "mailSend": {
              let previousIds: string[] = [];
              if (request.operation === "slackSend") {
                const target = safeUrl(request.channelUrl);
                if (
                  !belongsTo(app, request.channelUrl, slackWorkspaceId) ||
                  !target ||
                  !/^\/client\/[TE][A-Z0-9]+\/C[A-Z0-9]+\/?$/.test(target.pathname) ||
                  target.search ||
                  target.hash
                )
                  return yield* fail("account_mismatch");
                yield* navigate(target.href);
              } else {
                if (
                  request.to.some((email) => !emailPattern.test(email)) ||
                  new Set(request.to.map((email) => email.toLowerCase())).size !== request.to.length
                )
                  return yield* fail("invalid_configuration");
                yield* navigate(configuration.outlookUrl);
                yield* click("newMail");
                for (const email of request.to) {
                  const locator = yield* control("recipient");
                  yield* type(locator, email);
                  yield* invoke("press", { key: "Enter" });
                }
                yield* fill("subject", request.subject);
              }
              yield* fill("editor", request.text);
              const sendLocator = yield* control("sendButton", request);
              const before = yield* observe("beforeSend", {}, false);
              if (request.operation === "slackSend") {
                if (!before.ids) return yield* fail("ui_changed");
                previousIds = [...before.ids];
              }
              if (
                request.operation === "slackSend" &&
                before.url.replace(/\/$/, "") !== request.channelUrl.replace(/\/$/, "")
              )
                return yield* fail("account_mismatch");
              const pending = yield* result("send_unknown", undefined, request.operationId);
              // Record intent before the only Send click. A crash/timeout stays unknown; replays never click again.
              yield* save(
                receiptPath!,
                yield* encodeReceipt({
                  fingerprint: fingerprint!,
                  result: pending,
                }).pipe(Effect.mapError(storageError)),
              );
              const outcome = yield* Effect.gen(function* () {
                yield* clickLocator(sendLocator);
                yield* observe("sent", { text: request.text, previousIds });
                return yield* result("confirmed", undefined, request.operationId);
              }).pipe(Effect.orElseSucceed(() => pending));
              yield* save(
                receiptPath!,
                yield* encodeReceipt({
                  fingerprint: fingerprint!,
                  result: outcome,
                }).pipe(Effect.mapError(storageError)),
              );
              return outcome;
            }
          }
        });
        return yield* workflow.pipe(
          Effect.catchIf(
            (error) => error.code === "auth_required",
            () => result("auth_required"),
          ),
        );
      }),
    );
  return WorkBrowser.of({ configure, run });
});

export const layer = Layer.effect(WorkBrowser, make);

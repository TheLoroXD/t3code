import { BrowserProfileId, PreviewTabId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ReadBackends, SlackApiIdentity } from "./readSchema.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const requiredText = (max: number) => text(max).check(Schema.isNonEmpty());
export const Account = requiredText(80).check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/));
export const App = Schema.Literals(["slack", "outlook"]);
export type App = typeof App.Type;
export const Configuration = Schema.Struct({
  account: Account,
  profileId: BrowserProfileId,
  slackUrl: requiredText(2048),
  outlookUrl: Schema.optionalKey(requiredText(2048)),
  accountEmail: requiredText(254),
  readBackends: Schema.optionalKey(ReadBackends),
  slackApi: Schema.optionalKey(SlackApiIdentity),
});
export type Configuration = typeof Configuration.Type;

export class WorkBrowserError extends Schema.TaggedError<WorkBrowserError>()("WorkBrowserError", {
  code: Schema.Literals([
    "configuration_required",
    "invalid_configuration",
    "invalid_reference",
    "ui_changed",
    "account_mismatch",
    "browser_unavailable",
    "storage_failed",
    "operation_conflict",
    "auth_required",
    "capability_unavailable",
    "origin_changed",
    "permission_denied",
    "api_timeout",
    "api_network",
    "rate_limited",
    "response_incompatible",
    "not_found",
    "upstream_failed",
    "response_too_large",
    "browser_busy",
    "invalid_cursor",
    "read_deadline",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
  backend: Schema.optionalKey(Schema.Literals(["dom", "api"])),
  httpStatus: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 599 }))),
}) {
  override get message(): string {
    const messages = {
      configuration_required:
        "Configure one existing persistent browser profile with work_browser_configure first.",
      invalid_configuration:
        "Use a persistent profile, a Slack workspace name or URL, and your account email. Outlook defaults to https://outlook.office.com/mail/.",
      invalid_reference:
        "This reference is expired or belongs to another profile. Search again to obtain a current reference.",
      ui_changed:
        "The expected page or controls were not found uniquely. Inspect the work-browser tab.",
      account_mismatch:
        "The page's account or destination does not match the configured account or requested destination.",
      browser_unavailable:
        "The work browser is unavailable or its control was interrupted. Check the returned browser tab.",
      storage_failed:
        "Work-browser state could not be saved safely. No new send will be attempted.",
      operation_conflict:
        "This operationId was already used with different content. Use a new operationId for a different send.",
      auth_required: "Resume the existing work-browser login before issuing more requests.",
      capability_unavailable:
        "This account and operation have not passed API capability validation. Select DOM explicitly.",
      origin_changed:
        "The dedicated read tab changed origin or navigated. Start a new query after checking its account.",
      permission_denied:
        "The session does not have permission for this API read. Authentication was not retried.",
      api_timeout: "The page request reached its timeout and was aborted.",
      api_network: "The API read failed in the browser. No other backend was attempted.",
      rate_limited: "The read retry budget cannot satisfy the provider's rate limit. Retry later.",
      response_incompatible: "The API response did not match the bounded read contract.",
      not_found: "The requested conversation or message is unavailable to this session.",
      upstream_failed: "The upstream API rejected the read.",
      response_too_large: "The API response exceeded the bounded read size.",
      browser_busy: "The dedicated API read tab is unavailable or controlled by a human.",
      invalid_cursor:
        "The continuation expired or belongs to a different account, identity, backend or query.",
      read_deadline:
        "The bounded read deadline was reached before another page could be requested.",
    };
    return messages[this.code];
  }
}

export const SearchInput = Schema.Struct({
  account: Account,
  query: requiredText(1000),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optionalKey(requiredText(200)),
});
export const ReadInput = Schema.Struct({
  account: Account,
  messageRef: requiredText(200),
  cursor: Schema.optionalKey(requiredText(200)),
});
export const SlackSendInput = Schema.Struct({
  account: Account,
  channelUrl: requiredText(2048),
  text: requiredText(10000),
  operationId: requiredText(200),
});
export const MailSendInput = Schema.Struct({
  account: Account,
  to: Schema.Array(requiredText(254)).check(Schema.isMinLength(1)).check(Schema.isMaxLength(20)),
  subject: requiredText(255),
  text: requiredText(10000),
  operationId: requiredText(200),
});
export const CalendarListInput = Schema.Struct({
  account: Account,
  date: requiredText(10),
  timeZone: requiredText(100),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const StatusInput = Schema.Struct({ account: Account, app: App });
export type Request =
  | ({ readonly operation: "status" | "resume" } & typeof StatusInput.Type)
  | ({ readonly operation: "slackSearch" | "mailSearch" } & typeof SearchInput.Type)
  | ({ readonly operation: "slackRead" | "mailRead" } & typeof ReadInput.Type)
  | ({ readonly operation: "slackSend" } & typeof SlackSendInput.Type)
  | ({ readonly operation: "mailSend" } & typeof MailSendInput.Type)
  | ({ readonly operation: "calendar" } & typeof CalendarListInput.Type);
export const Item = Schema.Struct({
  ref: Schema.String,
  kind: Schema.Literals(["message", "mail", "event"]),
  text: text(16000),
  author: Schema.NullOr(text(500)),
  subject: Schema.NullOr(text(1000)),
  sourceUrl: Schema.NullOr(text(2048)),
  timestamp: Schema.NullOr(text(200)),
});
export const PageObservation = Schema.Struct({
  state: Schema.Literals(["ready", "auth_required", "ui_changed", "account_mismatch"]),
  url: Schema.String,
  account: Schema.NullOr(Schema.String),
  items: Schema.Array(
    Schema.Struct({
      ...Item.fields,
      id: Schema.String,
    }),
  ),
  more: Schema.Boolean,
  locator: Schema.NullOr(Schema.String),
  point: Schema.optionalKey(Schema.Struct({ x: Schema.Finite, y: Schema.Finite })),
  month: Schema.optionalKey(Schema.String),
  ids: Schema.optionalKey(Schema.Array(text(200)).check(Schema.isMaxLength(1000))),
});
export type PageObservation = typeof PageObservation.Type;
export const Result = Schema.Struct({
  account: Account,
  state: Schema.Literals(["ready", "auth_required", "confirmed", "send_unknown"]),
  app: App,
  profileId: Schema.String,
  tabId: Schema.optionalKey(PreviewTabId),
  browserThreadId: Schema.optionalKey(ThreadId),
  observedAt: Schema.String,
  items: Schema.Array(Item),
  partial: Schema.Boolean,
  effects: Schema.Array(Schema.String),
  notify: Schema.Boolean,
  authEpisode: Schema.NullOr(Schema.String),
  authThreadId: Schema.optionalKey(ThreadId),
  operationId: Schema.optionalKey(Schema.String),
  backend: Schema.optionalKey(Schema.Literals(["dom", "api"])),
  validatedIdentity: Schema.optionalKey(requiredText(200)),
  coverage: Schema.optionalKey(Schema.Literals(["rendered", "workspace", "enterprise", "thread"])),
  cursor: Schema.optionalKey(requiredText(200)),
});
export type Result = typeof Result.Type;

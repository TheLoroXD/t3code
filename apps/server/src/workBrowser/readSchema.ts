import * as Schema from "effect/Schema";

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const id = (pattern: RegExp) => bounded(100).check(Schema.isPattern(pattern));
export const SlackApiIdentity = Schema.Struct({
  environmentId: bounded(200).check(Schema.isNonEmpty()),
  teamId: id(/^T[A-Z0-9]+$/),
  userId: id(/^U[A-Z0-9]+$/),
  enterpriseId: Schema.optionalKey(id(/^E[A-Z0-9]+$/)),
  workspaceOrigin: bounded(200).check(Schema.isPattern(/^https:\/\/[a-z0-9-]+\.slack\.com$/)),
  searchScope: Schema.Literals(["enterprise", "workspace"]),
});
export type SlackApiIdentity = typeof SlackApiIdentity.Type;

const backend = Schema.Literals(["dom", "api"]);
export const ReadBackends = Schema.Struct({
  slackSearch: Schema.optionalKey(backend),
  slackRead: Schema.optionalKey(backend),
  mailSearch: Schema.optionalKey(backend),
  mailRead: Schema.optionalKey(backend),
  calendar: Schema.optionalKey(backend),
});

export const SlackPageRequest = Schema.Struct({
  operation: Schema.Literals(["identity", "search", "thread"]),
  identity: SlackApiIdentity,
  query: Schema.optionalKey(bounded(1000).check(Schema.isNonEmpty())),
  page: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))),
  count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  channel: Schema.optionalKey(id(/^[CDG][A-Z0-9]+$/)),
  ts: Schema.optionalKey(id(/^\d{10,16}\.\d{1,6}$/)),
  cursor: Schema.optionalKey(bounded(2000).check(Schema.isPattern(/^[A-Za-z0-9+/=_-]*$/))),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 8000 }))),
});
export type SlackPageRequest = typeof SlackPageRequest.Type;

const ApiReadCode = Schema.Literals([
  "auth_required",
  "account_mismatch",
  "origin_changed",
  "permission_denied",
  "capability_unavailable",
  "api_timeout",
  "api_network",
  "rate_limited",
  "response_incompatible",
  "not_found",
  "upstream_failed",
  "response_too_large",
]);
const SlackApiItem = Schema.Struct({
  id: id(/^\d{10,16}\.\d{1,6}$/),
  channel: id(/^[CDG][A-Z0-9]+$/),
  threadTs: id(/^\d{10,16}\.\d{1,6}$/),
  text: bounded(6000),
  author: Schema.NullOr(bounded(100)),
  sourceUrl: bounded(2048),
  timestamp: bounded(100),
  partial: Schema.Boolean,
});
export const SlackPageResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    items: Schema.Array(SlackApiItem).check(Schema.isMaxLength(20)),
    more: Schema.Boolean,
    nextPage: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
    ),
    cursor: Schema.optionalKey(bounded(2000).check(Schema.isPattern(/^[A-Za-z0-9+/=_-]*$/))),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: ApiReadCode,
    status: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 599 })),
    retryAfterMs: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })),
    ),
  }),
]);
export type SlackPageResult = typeof SlackPageResult.Type;

// Only these account/capability pairs passed the phase-one session experiment.
export const apiReadVerified = (account: string, operation: string) =>
  account === "verato" && (operation === "slackSearch" || operation === "slackRead");

export const redactReadText = (value: string) =>
  value
    .replace(/\bxox[a-z]-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");

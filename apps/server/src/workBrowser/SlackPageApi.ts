// @effect-diagnostics globalDate:off preferSchemaOverJson:off globalFetch:off -- Page-local code cannot import server services or schemas.
/// <reference lib="dom" />
import type { SlackPageRequest, SlackPageResult } from "./readSchema.ts";

/** Self-contained: secrets stay in this invocation's page-local variables. */
export async function slackPageRead(input: SlackPageRequest): Promise<SlackPageResult> {
  const error = (
    code: Extract<SlackPageResult, { ok: false }>["code"],
    status = 0,
  ): SlackPageResult => ({ ok: false, code, status });
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const string = (value: unknown) => (typeof value === "string" ? value : undefined);
  const expected = input.identity;
  const correctOrigin = () =>
    location.origin === "https://app.slack.com" &&
    new RegExp(
      `^/client/(${expected.teamId}|${expected.enterpriseId ?? expected.teamId})(?:/|$)`,
    ).test(location.pathname);
  if (!correctOrigin()) return error("origin_changed");
  if (!["identity", "search", "thread"].includes(input.operation))
    return error("capability_unavailable");
  if (input.operation === "search" && (!input.query || input.query.length > 1000))
    return error("response_incompatible");
  if (
    input.operation === "thread" &&
    (!/^[CDG][A-Z0-9]+$/.test(input.channel ?? "") || !/^\d{10,16}\.\d{1,6}$/.test(input.ts ?? ""))
  )
    return error("response_incompatible");

  let token: string | undefined;
  try {
    const candidates = new Set<string>();
    for (const key of ["localConfig_v2", "localConfig_v3"]) {
      const config = record(JSON.parse(localStorage.getItem(key) ?? "{}"));
      const team = record(record(config?.teams)?.[expected.teamId]);
      if (!team) continue;
      if (
        team.user_id !== expected.userId ||
        (string(team.enterprise_id) ?? undefined) !== expected.enterpriseId
      )
        return error("account_mismatch");
      const credential = string(team.token);
      if (credential) candidates.add(credential);
    }
    if (candidates.size > 1) return error("account_mismatch");
    if (candidates.size === 0) return error("auth_required");
    token = [...candidates][0];
  } catch {
    return error("response_incompatible");
  }

  const method =
    input.operation === "identity"
      ? "auth.test"
      : input.operation === "search"
        ? "search.messages"
        : "conversations.replies";
  const form = new URLSearchParams({
    token: token!,
    _x_team_id: expected.teamId,
    _x_reason: "api_call",
    _x_mode: "online",
    _x_app_name: "client",
  });
  const count = Math.max(1, Math.min(20, input.count ?? 20));
  if (input.operation === "search") {
    form.set("query", input.query!);
    form.set("count", String(count));
    form.set("page", String(input.page ?? 1));
    form.set("sort", "timestamp");
    form.set("sort_dir", "desc");
  } else if (input.operation === "thread") {
    form.set("channel", input.channel!);
    form.set("ts", input.ts!);
    form.set("limit", String(count));
    if (input.cursor) form.set("cursor", input.cursor);
  }
  const signal = AbortSignal.timeout(Math.max(20, Math.min(8000, input.timeoutMs ?? 5000)));
  try {
    // Origin is checked in the same fixed function that sends the relative request.
    if (!correctOrigin()) return error("origin_changed");
    const response = await fetch(`/api/${method}`, {
      method: "POST",
      body: form,
      credentials: "include",
      redirect: "error",
      signal,
    });
    token = undefined;
    if (!correctOrigin()) return error("origin_changed");
    if (response.status === 429) {
      const raw = response.headers.get("Retry-After");
      const seconds = raw === null ? NaN : Number(raw);
      const retryAfterMs =
        Number.isFinite(seconds) && seconds >= 0
          ? Math.ceil(seconds * 1000)
          : raw === null
            ? 1000
            : Math.max(0, Date.parse(raw) - Date.now());
      return {
        ok: false,
        code: "rate_limited",
        status: 429,
        ...(Number.isFinite(retryAfterMs) && retryAfterMs <= 60_000 ? { retryAfterMs } : {}),
      };
    }
    if (!response.ok)
      return error(
        response.status === 401
          ? "auth_required"
          : response.status === 403
            ? "permission_denied"
            : response.status === 404
              ? "not_found"
              : "upstream_failed",
        response.status,
      );
    // Bound upstream JSON even when Content-Length is absent or inaccurate.
    if (!response.body) return error("response_incompatible", response.status);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 512_000) {
          await reader.cancel();
          return error("response_too_large", response.status);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let data: Record<string, unknown> | undefined;
    try {
      data = record(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      return error("response_incompatible", response.status);
    }
    if (!data || typeof data.ok !== "boolean")
      return error("response_incompatible", response.status);
    if (!data.ok) {
      const code = string(data.error);
      return error(
        [
          "not_authed",
          "invalid_auth",
          "token_revoked",
          "token_expired",
          "account_inactive",
        ].includes(code ?? "")
          ? "auth_required"
          : ["missing_scope", "not_in_channel", "not_allowed_token_type", "access_denied"].includes(
                code ?? "",
              )
            ? "permission_denied"
            : ["channel_not_found", "message_not_found"].includes(code ?? "")
              ? "not_found"
              : code === "ratelimited"
                ? "rate_limited"
                : "upstream_failed",
        response.status,
      );
    }
    if (input.operation === "identity") {
      if (
        data.team_id !== expected.teamId ||
        data.user_id !== expected.userId ||
        (string(data.enterprise_id) ?? undefined) !== expected.enterpriseId ||
        data.url !== `${expected.workspaceOrigin}/`
      )
        return error("account_mismatch", response.status);
      return { ok: true, items: [], more: false };
    }
    const messages = record(data.messages);
    const rows = input.operation === "search" ? messages?.matches : data.messages;
    // conversations.replies returns the root on every page in addition to `limit` replies.
    if (!Array.isArray(rows) || rows.length > (input.operation === "thread" ? count + 1 : count))
      return error("response_incompatible", response.status);
    const items: Extract<SlackPageResult, { ok: true }>["items"][number][] = [];
    for (const value of rows) {
      const row = record(value);
      if (!row) return error("response_incompatible", response.status);
      const ts = string(row.ts),
        channel = input.operation === "search" ? string(record(row.channel)?.id) : input.channel;
      if (!ts || !/^\d{10,16}\.\d{1,6}$/.test(ts) || !channel || !/^[CDG][A-Z0-9]+$/.test(channel))
        return error("response_incompatible", response.status);
      const permalink = `${expected.workspaceOrigin}/archives/${channel}/p${ts.replace(".", "")}`;
      // Search permalinks of thread replies carry only `?thread_ts=<root>`; their rows may omit thread_ts.
      let linkedThreadTs: string | undefined;
      if (input.operation === "search" && row.permalink !== permalink) {
        const link = string(row.permalink) ?? "";
        const prefix = `${permalink}?thread_ts=`;
        linkedThreadTs = link.startsWith(prefix) ? link.slice(prefix.length) : undefined;
        if (!linkedThreadTs || !/^\d{10,16}\.\d{1,6}$/.test(linkedThreadTs))
          return error("account_mismatch", response.status);
      }
      const threadTs =
        string(row.thread_ts) ?? linkedThreadTs ?? (input.operation === "thread" ? input.ts : ts);
      if (
        !threadTs ||
        !/^\d{10,16}\.\d{1,6}$/.test(threadTs) ||
        (linkedThreadTs !== undefined && threadTs !== linkedThreadTs)
      )
        return error("response_incompatible", response.status);
      if (
        input.operation === "search" &&
        row.team !== expected.teamId &&
        !(expected.searchScope === "enterprise" && row.team === expected.enterpriseId)
      )
        return error("account_mismatch", response.status);
      if (input.operation === "thread" && threadTs !== input.ts)
        return error("account_mismatch", response.status);
      // Continuation pages repeat the root; only the first page reports it.
      if (input.operation === "thread" && input.cursor && ts === input.ts) continue;
      const text = string(row.text);
      const author = string(row.user);
      if (text === undefined || (author !== undefined && !/^[UW][A-Z0-9]+$/.test(author)))
        return error("response_incompatible", response.status);
      const maxText = input.operation === "search" ? 1000 : 2000;
      const clean = text
        .replace(/\bxox[a-z]-[A-Za-z0-9-]+/g, "[redacted]")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
      let boundedText = clean.slice(0, maxText);
      while (new TextEncoder().encode(boundedText).length > maxText)
        boundedText = boundedText.slice(0, -1);
      items.push({
        id: ts,
        channel,
        threadTs,
        text: boundedText,
        author: author ?? null,
        sourceUrl: threadTs === ts ? permalink : `${permalink}?thread_ts=${threadTs}`,
        timestamp: ts,
        partial: boundedText !== text || text.length === 0,
      });
    }
    if (input.operation === "search") {
      const paging = record(messages?.paging);
      if (
        !paging ||
        !Number.isInteger(paging.page) ||
        !Number.isInteger(paging.pages) ||
        !Number.isInteger(paging.total) ||
        Number(paging.total) < 0 ||
        Number(paging.pages) < 0 ||
        paging.page !== (input.page ?? 1) ||
        Number(paging.pages) > 1_000_000 ||
        (Number(paging.total) > 0 &&
          (Number(paging.pages) < Number(paging.page) || items.length === 0))
      )
        return error("response_incompatible", response.status);
      const more = Number(paging.page) < Number(paging.pages);
      return { ok: true, items, more, ...(more ? { nextPage: Number(paging.page) + 1 } : {}) };
    }
    const cursor = string(record(data.response_metadata)?.next_cursor) ?? "";
    if (
      typeof data.has_more !== "boolean" ||
      cursor.length > 2000 ||
      !/^[A-Za-z0-9+/=_-]*$/.test(cursor) ||
      (data.has_more && (!cursor || items.length === 0)) ||
      (!data.has_more && cursor)
    )
      return error("response_incompatible", response.status);
    return { ok: true, items, more: data.has_more, ...(cursor ? { cursor } : {}) };
  } catch {
    return error(signal.aborted ? "api_timeout" : "api_network");
  }
}

// @effect-diagnostics nodeBuiltinImport:off -- VM fixtures test the browser function without real sessions.
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { slackPageRead } from "./SlackPageApi.ts";
import {
  type SlackApiIdentity,
  type SlackPageRequest,
  type SlackPageResult,
} from "./readSchema.ts";

const identity: SlackApiIdentity = {
  environmentId: "devbox-fixture",
  teamId: "TWORK",
  userId: "UWORK",
  enterpriseId: "EWORK",
  workspaceOrigin: "https://work.slack.com",
  searchScope: "enterprise",
};
const credential = "fixture-credential";
const row = {
  ts: "1791939726.315089",
  channel: { id: "CGENERAL" },
  team: "TWORK",
  user: "UWORK",
  text: "A fixture message",
  permalink: "https://work.slack.com/archives/CGENERAL/p1791939726315089",
};
const search = { ok: true, messages: { matches: [row], paging: { page: 1, pages: 2, total: 2 } } };
type Fixture = {
  response?: Response;
  storage?: Record<string, string>;
  origin?: string;
  path?: string;
  fetch?: typeof fetch;
};
async function run(input: Partial<SlackPageRequest> = {}, fixture: Fixture = {}) {
  const requests: Array<{
    url: string;
    params: URLSearchParams;
    redirect: RequestRedirect | undefined;
  }> = [];
  const storage = fixture.storage ?? {
    localConfig_v2: JSON.stringify({
      teams: {
        TOTHER: { user_id: "UOTHER", token: "other-fixture-credential" },
        TWORK: { user_id: "UWORK", enterprise_id: "EWORK", token: credential },
      },
    }),
  };
  const value = (await NodeVM.runInNewContext(`(${slackPageRead.toString()})(input)`, {
    input: { operation: "search", identity, query: "fixture", count: 2, ...input },
    location: {
      origin: fixture.origin ?? "https://app.slack.com",
      pathname: fixture.path ?? "/client/EWORK/CGENERAL",
    },
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    fetch:
      fixture.fetch ??
      (async (url: string, options: RequestInit) => {
        requests.push({
          url,
          params: new URLSearchParams(String(options.body)),
          redirect: options.redirect,
        });
        return fixture.response ?? Response.json(search);
      }),
    AbortSignal,
    URLSearchParams,
    Uint8Array,
    TextDecoder,
    TextEncoder,
    Date,
  })) as SlackPageResult;
  return { value, requests };
}

describe("registered Slack page reads", () => {
  it("selects the registered team and serializes hostile query text as data", async () => {
    const query = '");globalThis.injected=true;//';
    const { value, requests } = await run({ query });
    expect(value).toMatchObject({ ok: true, more: true, nextPage: 2 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/api/search.messages");
    expect(requests[0]!.params.get("query")).toBe(query);
    expect(requests[0]!.params.get("token")).toBe(credential);
    expect(requests[0]!.redirect).toBe("error");
    expect(JSON.stringify(value)).not.toContain(credential);
  });
  it("requires upstream user, workspace and Enterprise identity before the service reads data", async () => {
    const good = {
      ok: true,
      team_id: "TWORK",
      user_id: "UWORK",
      enterprise_id: "EWORK",
      url: "https://work.slack.com/",
    };
    expect(
      (await run({ operation: "identity" }, { response: Response.json(good) })).value,
    ).toMatchObject({ ok: true });
    for (const changed of [
      { user_id: "UOTHER" },
      { team_id: "TOTHER" },
      { enterprise_id: "EOTHER" },
      { url: "https://other.slack.com/" },
    ]) {
      expect(
        (await run({ operation: "identity" }, { response: Response.json({ ...good, ...changed }) }))
          .value,
      ).toMatchObject({ ok: false, code: "account_mismatch" });
    }
  });
  it("rejects mixed identities, ambiguous credentials and logout without an upstream request", async () => {
    for (const storage of [
      {
        localConfig_v2: JSON.stringify({
          teams: { TWORK: { token: credential, user_id: "UOTHER", enterprise_id: "EWORK" } },
        }),
      },
      {
        localConfig_v2: JSON.stringify({
          teams: { TWORK: { token: credential, user_id: "UWORK", enterprise_id: "EWORK" } },
        }),
        localConfig_v3: JSON.stringify({
          teams: { TWORK: { token: "second-fixture", user_id: "UWORK", enterprise_id: "EWORK" } },
        }),
      },
    ]) {
      const result = await run({}, { storage });
      expect(result.value).toMatchObject({ code: "account_mismatch" });
      expect(result.requests).toHaveLength(0);
    }
    const loggedOut = await run({}, { storage: {} });
    expect(loggedOut.value).toMatchObject({ code: "auth_required" });
    expect(loggedOut.requests).toHaveLength(0);
  });
  it("deduplicates equivalent cache entries without exporting their contents", async () => {
    const entry = JSON.stringify({
      teams: { TWORK: { user_id: "UWORK", enterprise_id: "EWORK", token: credential } },
    });
    expect(
      (await run({}, { storage: { localConfig_v2: entry, localConfig_v3: entry } })).value,
    ).toMatchObject({ ok: true });
  });
  it("checks the page origin and workspace in the function that sends the request", async () => {
    for (const fixture of [
      { origin: "https://attacker.example" },
      { path: "/client/EOTHER/CGENERAL" },
    ]) {
      const result = await run({}, fixture);
      expect(result.value).toMatchObject({ code: "origin_changed" });
      expect(result.requests).toHaveLength(0);
    }
  });
  it("classifies HTTP and Slack errors using a closed list, excluding error bodies", async () => {
    for (const [status, code] of [
      [401, "auth_required"],
      [403, "permission_denied"],
      [404, "not_found"],
      [500, "upstream_failed"],
    ] as const) {
      const { value } = await run(
        {},
        { response: new Response("sensitive-response-body", { status }) },
      );
      expect(value).toMatchObject({ ok: false, code, status });
      expect(JSON.stringify(value)).not.toContain("sensitive");
    }
    for (const [upstream, code] of [
      ["invalid_auth", "auth_required"],
      ["missing_scope", "permission_denied"],
      ["unknown-sensitive", "upstream_failed"],
    ] as const) {
      const { value } = await run(
        {},
        { response: Response.json({ ok: false, error: upstream, errorText: "private-fixture" }) },
      );
      expect(value).toMatchObject({ code, status: 200 });
      expect(JSON.stringify(value)).not.toContain("private-fixture");
    }
  });
  it("preserves Retry-After and refuses a retry budget larger than one minute", async () => {
    expect(
      (
        await run(
          {},
          { response: new Response("", { status: 429, headers: { "Retry-After": "2" } }) },
        )
      ).value,
    ).toMatchObject({ code: "rate_limited", retryAfterMs: 2000 });
    expect(
      (
        await run(
          {},
          { response: new Response("", { status: 429, headers: { "Retry-After": "120" } }) },
        )
      ).value,
    ).toEqual({ ok: false, code: "rate_limited", status: 429 });
  });
  it("rejects malformed, incomplete and foreign results without claiming an empty complete read", async () => {
    for (const response of [
      new Response("not-json"),
      Response.json({ ok: true }),
      Response.json({
        ...search,
        messages: { ...search.messages, matches: [], paging: { page: 1, pages: 2, total: 2 } },
      }),
      Response.json({
        ...search,
        messages: { ...search.messages, matches: [{ ...row, team: "TOTHER" }] },
      }),
      Response.json({
        ...search,
        messages: {
          ...search.messages,
          matches: [{ ...row, permalink: "https://attacker.example/" }],
        },
      }),
    ])
      expect((await run({}, { response })).value).toMatchObject({ ok: false });
    expect((await run({}, { response: new Response("x".repeat(512001)) })).value).toMatchObject({
      code: "response_too_large",
    });
    expect(
      (
        await run(
          {},
          {
            response: Response.json({
              ok: true,
              messages: { matches: [], paging: { page: 1, pages: 0, total: 0 } },
            }),
          },
        )
      ).value,
    ).toEqual({ ok: true, items: [], more: false });
  });
  it("reads a thread page and validates continuation instead of fetching an arbitrary destination", async () => {
    const input = { operation: "thread" as const, channel: "CGENERAL", ts: row.ts };
    const response = {
      ok: true,
      messages: [{ ...row, channel: undefined }],
      has_more: true,
      response_metadata: { next_cursor: "fixture-cursor=" },
    };
    const result = await run(input, { response: Response.json(response) });
    expect(result.value).toMatchObject({ ok: true, more: true, cursor: "fixture-cursor=" });
    expect(result.requests[0]!.url).toBe("/api/conversations.replies");
    expect(
      (
        await run(input, {
          response: Response.json({
            ...response,
            response_metadata: { next_cursor: "https://attacker.example/" },
          }),
        })
      ).value,
    ).toMatchObject({ code: "response_incompatible" });
    expect(
      (await run(input, { response: Response.json({ ...response, response_metadata: {} }) })).value,
    ).toMatchObject({ code: "response_incompatible" });
  });
  it("accepts search permalinks of thread replies and derives their thread from the link", async () => {
    const root = "1791921504.084689";
    const link = `${row.permalink}?thread_ts=${root}`;
    const reply = Response.json({
      ...search,
      messages: { ...search.messages, matches: [{ ...row, permalink: link }] },
    });
    const { value } = await run({}, { response: reply });
    expect(value).toMatchObject({ ok: true, items: [{ threadTs: root, sourceUrl: link }] });
    for (const permalink of [
      `${link}&cid=CGENERAL`,
      `${row.permalink}?thread_ts=not-a-ts`,
      `${row.permalink}?cid=CGENERAL`,
      `https://other.slack.com/archives/CGENERAL/p1791939726315089?thread_ts=${root}`,
    ])
      expect(
        (
          await run(
            {},
            {
              response: Response.json({
                ...search,
                messages: { ...search.messages, matches: [{ ...row, permalink }] },
              }),
            },
          )
        ).value,
      ).toMatchObject({ ok: false, code: "account_mismatch" });
    expect(
      (
        await run(
          {},
          {
            response: Response.json({
              ...search,
              messages: {
                ...search.messages,
                matches: [{ ...row, permalink: link, thread_ts: "1791921999.000001" }],
              },
            }),
          },
        )
      ).value,
    ).toMatchObject({ ok: false, code: "response_incompatible" });
  });
  it("accepts the root beside `limit` replies and drops it from continuation pages", async () => {
    const root = { ...row, channel: undefined, ts: "1791921504.084689" };
    const reply = (n: number) => ({
      ...row,
      channel: undefined,
      ts: `17919216${String(n).padStart(2, "0")}.000100`,
      thread_ts: root.ts,
    });
    const input = { operation: "thread" as const, channel: "CGENERAL", ts: root.ts, count: 2 };
    const page = (messages: unknown[]) =>
      Response.json({
        ok: true,
        messages,
        has_more: true,
        response_metadata: { next_cursor: "next-fixture" },
      });
    const first = await run(input, { response: page([root, reply(9), reply(10)]) });
    expect(first.value).toMatchObject({ ok: true, more: true });
    if (first.value.ok) {
      expect(first.value.items.map((item) => item.id)).toEqual([
        root.ts,
        reply(9).ts,
        reply(10).ts,
      ]);
      expect(first.value.items[0]!.sourceUrl).toBe(
        "https://work.slack.com/archives/CGENERAL/p1791921504084689",
      );
      expect(first.value.items[1]!.sourceUrl).toBe(
        `https://work.slack.com/archives/CGENERAL/p1791921609000100?thread_ts=${root.ts}`,
      );
    }
    const next = await run(
      { ...input, cursor: "previous-fixture" },
      { response: page([root, reply(7), reply(8)]) },
    );
    expect(next.requests[0]!.params.get("cursor")).toBe("previous-fixture");
    expect(next.requests[0]!.params.get("oldest")).toBeNull();
    if (next.value.ok)
      expect(next.value.items.map((item) => item.id)).toEqual([reply(7).ts, reply(8).ts]);
    else expect.unreachable();
    expect(
      (await run(input, { response: page([root, reply(8), reply(9), reply(10)]) })).value,
    ).toMatchObject({ code: "response_incompatible" });
  });
  it("redacts synthetic credentials and marks truncated or unrepresented content partial", async () => {
    const response = Response.json({
      ...search,
      messages: {
        ...search.messages,
        matches: [
          { ...row, text: "xoxc-synthetic-fixture Bearer synthetic-fixture " + "á".repeat(1500) },
        ],
      },
    });
    const { value } = await run({}, { response });
    expect(value.ok).toBe(true);
    if (value.ok) {
      expect(value.items[0]!.partial).toBe(true);
      expect(value.items[0]!.text).not.toContain("synthetic-fixture");
      expect(new TextEncoder().encode(value.items[0]!.text).length).toBeLessThanOrEqual(1000);
    }
  });
  it("aborts the in-flight request on its page deadline and sanitizes network exceptions", async () => {
    let aborted = false;
    const fixtureFetch = (async (_url: unknown, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("private network details"));
          },
          { once: true },
        );
      })) as typeof fetch;
    const { value } = await run({ timeoutMs: 20 }, { fetch: fixtureFetch });
    expect(aborted).toBe(true);
    expect(value).toEqual({ ok: false, code: "api_timeout", status: 0 });
  });
});

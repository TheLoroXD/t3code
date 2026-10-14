// @effect-diagnostics globalFetch:off -- Requests in this file are synthetic browser fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { executeBrowserRead } from "./BrowserReadOperation.ts";
import type { SlackPageRequest } from "./readSchema.ts";

const input: SlackPageRequest = {
  operation: "identity",
  identity: {
    environmentId: "fixture-env",
    teamId: "TWORK",
    userId: "UWORK",
    enterpriseId: "EWORK",
    workspaceOrigin: "https://work.slack.com",
    searchScope: "enterprise",
  },
};

describe("browser-owner read operation in disposable Chromium contexts", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  it("executes the registered function with serialized arguments and blocks redirects", async () => {
    const context = await browser.newContext();
    const requests: string[] = [];
    try {
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        requests.push(url.hostname + url.pathname);
        if (url.pathname === "/api/auth.test")
          return route.fulfill({
            json: {
              ok: true,
              team_id: "TWORK",
              user_id: "UWORK",
              enterprise_id: "EWORK",
              url: "https://work.slack.com/",
            },
          });
        if (url.pathname === "/api/search.messages")
          return route.fulfill({ status: 302, headers: { location: "https://attacker.example/" } });
        return route.fulfill({ contentType: "text/html", body: "<html>Disposable fixture</html>" });
      });
      const page = await context.newPage();
      await page.goto("https://app.slack.com/client/EWORK");
      await page.evaluate(() =>
        localStorage.setItem(
          "localConfig_v2",
          JSON.stringify({
            teams: {
              TWORK: { token: "fixture-credential", user_id: "UWORK", enterprise_id: "EWORK" },
            },
          }),
        ),
      );
      expect(await executeBrowserRead(page, input)).toEqual({ ok: true, items: [], more: false });
      const value = await executeBrowserRead(page, {
        ...input,
        operation: "search",
        query: '");globalThis.injected=true;//',
      });
      expect(value).toMatchObject({ ok: false, code: "api_network" });
      expect(await page.evaluate(() => "injected" in globalThis)).toBe(false);
      expect(requests.some((url) => url.includes("attacker"))).toBe(false);
      const before = requests.length;
      expect(
        await executeBrowserRead(page, {
          ...input,
          operation: "arbitrary",
          url: "https://attacker.example/",
        }),
      ).toMatchObject({ code: "response_incompatible" });
      expect(requests).toHaveLength(before);
      await page.evaluate(() => localStorage.clear());
      expect(await executeBrowserRead(page, input)).toMatchObject({ code: "auth_required" });
      await page.goto("https://different.example/");
      expect(await executeBrowserRead(page, input)).toMatchObject({ code: "origin_changed" });
    } finally {
      await context.close();
    }
  });
  it("aborts a real browser fetch by its deadline without restarting a shared profile", async () => {
    const context = await browser.newContext();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).pathname === "/api/auth.test") {
          reached.resolve();
          await release.promise;
          await route.abort().catch(() => {});
          return;
        }
        await route.fulfill({
          contentType: "text/html",
          body: "<html>Disposable timeout fixture</html>",
        });
      });
      const page = await context.newPage();
      await page.goto("https://app.slack.com/client/EWORK");
      await page.evaluate(() =>
        localStorage.setItem(
          "localConfig_v2",
          JSON.stringify({
            teams: {
              TWORK: { token: "fixture-credential", user_id: "UWORK", enterprise_id: "EWORK" },
            },
          }),
        ),
      );
      const read = executeBrowserRead(page, { ...input, timeoutMs: 100 });
      await reached.promise;
      expect(await read).toEqual({ ok: false, code: "api_timeout", status: 0 });
      release.resolve();
      expect(await page.evaluate(() => document.title)).toBe("");
    } finally {
      release.resolve();
      await context.close();
    }
  });
});

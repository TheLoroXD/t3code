import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { pageProgram } from "./dom.ts";
import { PageObservation } from "./schema.ts";

const decodePage = Schema.decodeUnknownSync(PageObservation);

it("reads the current Outlook message body and rejects another mailbox or conversation", () => {
  let email = "person@work.example";
  let selectedId = "conversation-1";
  const element = (text: string, attributes: Record<string, string> = {}) => ({
    innerText: text,
    textContent: text,
    getClientRects: () => [{}],
    getAttribute: (name: string) => attributes[name] ?? null,
  });
  const body = element("The message itself", { "aria-label": "Cuerpo del mensaje" });
  const document = {
    querySelector: (selector: string) =>
      selector.includes("primaryMailboxRoot_")
        ? element(email, { "data-folder-name": email })
        : null,
    querySelectorAll: (selector: string) =>
      selector.includes("[data-testid='message-body']")
        ? [body]
        : selector === ".allowTextSelection"
          ? [element("Header"), element("Header plus message")]
          : selector === "[data-convid][aria-selected='true']"
            ? [element("", { "data-convid": selectedId })]
            : [],
  };
  const evaluate = () =>
    decodePage(
      NodeVM.runInNewContext(
        pageProgram("outlook", "mailBody", {
          id: "conversation-1",
          accountEmail: "person@work.example",
        }),
        {
          document,
          location: {
            href: "https://outlook.cloud.microsoft/mail/id/conversation-1",
            hostname: "outlook.cloud.microsoft",
          },
          TextEncoder,
        },
      ),
    );
  expect(evaluate().items[0]!.text).toBe("The message itself");
  selectedId = "conversation-2";
  expect(evaluate().state).toBe("ui_changed");
  email = "someone@other.example";
  expect(evaluate().state).toBe("account_mismatch");
});

it("verifies the calendar's display zone and exact rendered day", () => {
  let dates = ["2026-10-09"];
  let zone = "(UTC-06:00) Guadalajara, Ciudad de México, Monterrey";
  const element = (attributes: Record<string, string>) => ({
    getClientRects: () => [{}],
    getAttribute: (name: string) => attributes[name] ?? null,
  });
  const document = {
    querySelector: () => ({ textContent: "person@work.example", getAttribute: () => null }),
    querySelectorAll: (selector: string) =>
      selector === "[data-column-date]"
        ? dates.map((date) => element({ "data-column-date": date }))
        : selector === "input[role='combobox']"
          ? [
              {
                ...element({ "aria-label": "Mostrar mi calendario en la zona horaria:" }),
                value: zone,
              },
            ]
          : [],
  };
  const evaluate = (task: string) =>
    decodePage(
      NodeVM.runInNewContext(
        pageProgram("outlook", task, {
          date: "2026-10-09",
          timeZone: "America/Mexico_City",
          accountEmail: "person@work.example",
        }),
        {
          document,
          location: {
            href: "https://outlook.cloud.microsoft/calendar/view/day",
            hostname: "outlook.cloud.microsoft",
            pathname: "/calendar/view/day",
          },
          TextEncoder,
        },
      ),
    );
  expect(evaluate("calendarZone").state).toBe("ready");
  zone = "(UTC-08:00) Pacific Time (US & Canada)";
  expect(evaluate("calendarZone").state).toBe("ui_changed");
  expect(evaluate("calendar").state).toBe("ready");
  expect(evaluate("calendar").more).toBe(true);
  dates = ["2026-10-08"];
  expect(evaluate("calendar").state).toBe("ui_changed");
  dates = ["2026-10-08", "2026-10-09"];
  expect(evaluate("calendar").state).toBe("ui_changed");
});

it("clicks only a unique, enabled work control whose center is unobstructed", () => {
  let disabled = false;
  let hidden = false;
  const target = {
    getClientRects: () => [{}],
    checkVisibility: () => !hidden,
    matches: () => disabled,
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 40 }),
    contains: () => false,
  };
  let targets = [target];
  let hit: object | null = target;
  const locator = "[data-work-browser-search-button]";
  const evaluate = (selector = locator) =>
    decodePage(
      NodeVM.runInNewContext(pageProgram("slack", "clickPoint", { locator: selector }), {
        document: {
          querySelector: () => null,
          querySelectorAll: (selector: string) => (selector === locator ? targets : []),
          elementFromPoint: () => hit,
        },
        location: { href: "https://app.slack.com/client/EWORK", hostname: "app.slack.com" },
        TextEncoder,
      }),
    );
  expect(evaluate().point).toEqual({ x: 50, y: 40 });
  hit = {};
  expect(evaluate().state).toBe("ui_changed");
  hit = target;
  disabled = true;
  expect(evaluate().state).toBe("ui_changed");
  disabled = false;
  hidden = true;
  expect(evaluate().state).toBe("ui_changed");
  hidden = false;
  targets = [target, target];
  expect(evaluate().state).toBe("ui_changed");
  expect(evaluate("button").state).toBe("ui_changed");
});

it("submits the exact Slack query and rejects stale search results", () => {
  const query = "in:engineering release";
  let shownQuery = `Search: ${query}`;
  const option = {
    getClientRects: () => [{}],
    getAttribute: (name: string) => (name === "aria-label" ? `Search for: ${query}` : null),
    setAttribute: () => {},
  };
  const view = { getClientRects: () => [{}], innerText: "No results", contains: () => false };
  const document = {
    body: { innerText: "No results" },
    querySelector: (selector: string) =>
      selector === ".p-top_nav__search__text" ? { textContent: shownQuery } : null,
    querySelectorAll: (selector: string) =>
      selector === "[role='option']"
        ? [option]
        : selector.includes("[data-qa='search_view']")
          ? [view]
          : [],
  };
  const url = new URL("https://app.slack.com/client/EWORK/search");
  const evaluate = (task: string, input: object = { query }) =>
    decodePage(
      NodeVM.runInNewContext(pageProgram("slack", task, input), {
        document,
        location: { href: url.href, hostname: url.hostname, pathname: url.pathname },
        URL,
        TextEncoder,
      }),
    );
  expect(evaluate("searchSubmit").locator).toBe("[data-work-browser-search-submit]");
  expect(evaluate("searchSubmit", { query: "different" }).state).toBe("ui_changed");
  expect(evaluate("searchRows").state).toBe("ready");
  shownQuery = "Search: an earlier query";
  expect(evaluate("searchRows").state).toBe("ui_changed");
});

it("recognizes a workspace's SSO entry as a login hold", () => {
  const button = {
    textContent: "Sign in with SSO",
    getAttribute: () => null,
    getClientRects: () => [{}],
  };
  const url = new URL("https://verato.slack.com/");
  const page = decodePage(
    NodeVM.runInNewContext(pageProgram("slack", "status"), {
      document: {
        querySelector: () => null,
        querySelectorAll: (selector: string) => (selector.startsWith("button,") ? [button] : []),
      },
      location: { href: url.href, hostname: url.hostname, pathname: url.pathname },
      TextEncoder,
    }),
  );
  expect(page.state).toBe("auth_required");
});

it("maps Slack timestamp links within the selected workspace and bounds extracted Unicode data", () => {
  const text = "界".repeat(16000);
  const rows = Array.from({ length: 8 }, (_, index) => ({
    id: `row-${index}`,
    innerText: text,
    getClientRects: () => [{}],
    contains: () => false,
    getAttribute: () => null,
    querySelector: (selector: string) =>
      selector.startsWith("a.c-timestamp")
        ? { href: `https://workspace.slack.com/archives/CGENERAL/p176000000000000${index}` }
        : selector.includes("message-text")
          ? { textContent: text }
          : null,
  }));
  const document = {
    body: { innerText: text },
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector.startsWith(".c-search_message") ? rows : []),
  };
  const url = new URL("https://app.slack.com/client/EWORK/search?q=example");
  const raw = NodeVM.runInNewContext(
    pageProgram("slack", "rows", { query: "'); throw new Error('input executed');" }),
    {
      document,
      location: { href: url.href, hostname: url.hostname, pathname: url.pathname },
      URL,
      TextEncoder,
    },
  );
  const page = decodePage(raw);
  expect(page.state).toBe("ready");
  expect(page.items[0]!.sourceUrl).toBe(
    "https://app.slack.com/client/EWORK/CGENERAL/thread/CGENERAL-1760000000.000000",
  );
  expect(page.items[0]!.id).toBe("1760000000.000000");
  expect(page.items.length).toBeLessThan(rows.length);
  expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(52000);
  expect(page.more).toBe(true);
});

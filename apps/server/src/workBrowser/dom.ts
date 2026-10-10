/// <reference lib="dom" />
/** Fixed page programs. Tool input is data; it never supplies JavaScript or selectors. */
export function pageProgram(app: "slack" | "outlook", task: string, input: object = {}): string {
  return `(${runPage.toString()})(${JSON.stringify(app)},${JSON.stringify(task)},${JSON.stringify(input)})`;
}

function runPage(app: string, task: string, input: Record<string, unknown>) {
  const visible = (element: Element) => element.getClientRects().length > 0;
  const all = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible);
  const clean = (value: string | null | undefined, limit = 16000) =>
    (value ?? "").trim().slice(0, limit);
  const pageUrl = location.href;
  const accountElement = document.querySelector(
    "#meControl, [aria-label*='Account manager'], [data-testid='account-email']",
  );
  const accountText =
    accountElement?.getAttribute("aria-label") ?? accountElement?.textContent ?? "";
  const account = accountText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase() ?? null;
  const base = {
    state: "ready",
    url: pageUrl,
    account,
    items: [] as Array<{
      id: string;
      ref: string;
      kind: string;
      text: string;
      author: string | null;
      subject: string | null;
      sourceUrl: string | null;
      timestamp: string | null;
    }>,
    more: false,
    locator: null as string | null,
  };
  // Leave room below the browser's 64 KiB response ceiling for transport metadata.
  const push = (item: (typeof base.items)[number]) => {
    base.items.push(item);
    if (new TextEncoder().encode(JSON.stringify(base)).length < 52000) return true;
    base.items.pop();
    base.more = true;
    return false;
  };
  const hostname = location.hostname.toLowerCase();
  if (
    hostname.endsWith(".onelogin.com") ||
    ["login.microsoftonline.com", "login.live.com", "accounts.slack.com"].includes(hostname) ||
    all("input[type='password']").length > 0
  )
    return { ...base, state: "auth_required" };
  if (
    hostname.endsWith(".slack.com") &&
    (all("input[name='email'], input[name='domain'], [data-testid='signin']").length > 0 ||
      all("button, a, [role='button']").some((element) =>
        /^(Sign in|Log in|Sign in with SSO|Continue with SSO|Iniciar sesión)$/i.test(
          clean(element.getAttribute("aria-label") ?? element.textContent, 500),
        ),
      ))
  )
    return { ...base, state: "auth_required" };
  if (
    app === "slack"
      ? hostname !== "app.slack.com"
      : !["outlook.office.com", "outlook.office365.com", "outlook.cloud.microsoft"].includes(
          hostname,
        )
  )
    return { ...base, state: "ui_changed" };
  if (all("input[name='loginfmt'], input[name='email'], [data-testid='signin']").length > 0)
    return { ...base, state: "auth_required" };
  if (app === "outlook" && account !== null && account !== String(input.accountEmail).toLowerCase())
    return { ...base, state: "account_mismatch" };
  if (task === "status") {
    const ready =
      app === "slack"
        ? all(
            "[data-qa='workspace_name'], [data-testid='workspace-switcher'], .p-workspace, .p-client_container",
          ).length > 0
        : account !== null &&
          all("#topSearchInput, [role='navigation'], [data-testid='outlook-shell']").length > 0;
    return { ...base, state: ready ? "ready" : "ui_changed" };
  }

  const mark = (elements: HTMLElement[], name: string) => {
    for (const prior of document.querySelectorAll(`[data-work-browser-${name}]`))
      prior.removeAttribute(`data-work-browser-${name}`);
    if (elements.length !== 1) return { ...base, state: "ui_changed" };
    elements[0]!.setAttribute(`data-work-browser-${name}`, "true");
    return { ...base, locator: `[data-work-browser-${name}]` };
  };
  const namedButtons = (pattern: RegExp) =>
    all("button, [role='button']").filter((el) =>
      pattern.test(
        clean(el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent, 500),
      ),
    );
  const rowId = (row: HTMLElement) =>
    (app === "slack" ? row.getAttribute("data-ts") : null) ??
    row.getAttribute("data-item-id") ??
    row.getAttribute("data-convid") ??
    row.getAttribute("data-message-id") ??
    row.getAttribute("data-ts") ??
    row.id;

  if (task === "searchButton")
    return mark(all("button[data-qa='top_nav_search']"), "search-button");
  if (task === "searchSubmit")
    return mark(
      all("[role='option']").filter(
        (el) => el.getAttribute("aria-label") === `Search for: ${input.query}`,
      ),
      "search-submit",
    );
  if (task === "searchInput")
    return mark(
      all(
        app === "slack"
          ? "[role='combobox'][aria-label='Query'], input[data-testid='search_input'], input[role='combobox'][aria-label*='Search']"
          : "#topSearchInput, input[aria-label*='Search'], input[placeholder*='Search'], input[aria-label*='Buscar']",
      ),
      "search",
    );
  if (task === "newMail")
    return mark(namedButtons(/^(New mail|New message|Nuevo correo|Nuevo mensaje)$/i), "new");
  if (task === "mailRow")
    return mark(
      all("[data-convid], [data-item-id]").filter((row) => rowId(row) === input.id),
      "row",
    );
  if (task === "editor")
    return mark(
      all(
        app === "slack"
          ? "[contenteditable='true'][data-slate-editor], [contenteditable='true'].ql-editor, [contenteditable='true'][data-testid='message_input']"
          : "[contenteditable='true'][aria-label*='Message body'], [contenteditable='true'][aria-label*='Cuerpo del mensaje']",
      ).filter((el) => clean(el.innerText) === ""),
      "editor",
    );
  if (task === "subject")
    return mark(
      all(
        "input[aria-label='Subject'], input[placeholder='Add a subject'], input[aria-label='Asunto'], input[placeholder='Agregar un asunto']",
      ),
      "subject",
    );
  if (task === "recipient")
    return mark(
      all(
        "input[aria-label='To'], input[aria-label='Para'], input[aria-label='Required attendees'], input[aria-label='Asistentes requeridos']",
      ),
      "to",
    );
  if (task === "sendButton") {
    const editors = all("[data-work-browser-editor]");
    if (editors.length !== 1 || clean(editors[0]!.innerText) !== String(input.text).trim())
      return { ...base, state: "ui_changed" };
    if (app === "outlook") {
      if (account === null || account !== String(input.accountEmail).toLowerCase())
        return { ...base, state: "account_mismatch" };
      const subjects = all("[data-work-browser-subject]") as HTMLInputElement[];
      if (subjects.length !== 1 || subjects[0]!.value !== input.subject)
        return { ...base, state: "ui_changed" };
      let compose = editors[0]!.parentElement;
      while (
        compose &&
        compose !== document.body &&
        !(
          compose.contains(subjects[0]!) &&
          Array.from(compose.querySelectorAll("button, [role='button']")).some((el) =>
            /^(Send|Enviar)( \(.+\))?$/i.test(
              clean(el.getAttribute("aria-label") ?? el.textContent),
            ),
          )
        )
      )
        compose = compose.parentElement;
      if (!compose || compose === document.body) return { ...base, state: "ui_changed" };
      const senders = Array.from(
        compose.querySelectorAll(
          "[data-testid='sender-address'], [aria-label^='From:'], [aria-label^='De:']",
        ),
      );
      const senderEmails = senders.flatMap(
        (el) =>
          `${el.getAttribute("aria-label") ?? ""} ${el.textContent}`
            .toLowerCase()
            .match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g) ?? [],
      );
      const senderSet = new Set(senderEmails);
      if (senderSet.size !== 1 || !senderSet.has(String(input.accountEmail).toLowerCase()))
        return { ...base, state: "account_mismatch" };
      const recipients = Array.from(
        compose.querySelectorAll<HTMLElement>(
          "[data-testid='recipient'], [data-email], [role='listitem'][title], [aria-label*='@']",
        ),
      )
        .filter((el) => !senders.some((sender) => sender === el || sender.contains(el)))
        .map((el) =>
          `${el.getAttribute("data-email") ?? ""} ${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.innerText}`.toLowerCase(),
        );
      const expected = input.to as string[];
      const emailSet = new Set(
        recipients.flatMap((value) => value.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g) ?? []),
      );
      if (
        emailSet.size !== expected.length ||
        expected.some((email) => !emailSet.has(email.toLowerCase()))
      )
        return { ...base, state: "account_mismatch" };
      if (all("[data-work-browser-to]").some((el) => (el as HTMLInputElement).value.trim() !== ""))
        return { ...base, state: "ui_changed" };
      return mark(
        namedButtons(/^(Send|Enviar)( \(.+\))?$/i).filter((el) => compose!.contains(el)),
        "send",
      );
    }
    return mark(namedButtons(/^(Send|Enviar)( \(.+\))?$/i), "send");
  }
  if (task === "sent" || task === "beforeSend") {
    if (app === "outlook") {
      const alerts = all("[role='status'], [role='alert']");
      if (task === "beforeSend") {
        for (const el of alerts) el.setAttribute("data-work-browser-old-alert", "true");
        return base;
      }
      const success = alerts.some(
        (el) =>
          !el.hasAttribute("data-work-browser-old-alert") &&
          /message sent|mensaje enviado/i.test(el.innerText),
      );
      return {
        ...base,
        state: success && !all("[data-work-browser-editor]").length ? "ready" : "ui_changed",
      };
    }
    if (task === "beforeSend") {
      const ids = all(".c-message_kit__message, [data-testid='message_container']").map(rowId);
      if (
        ids.length > 1000 ||
        ids.some((id) => id.length > 200) ||
        new TextEncoder().encode(JSON.stringify(ids)).length > 45000
      )
        return { ...base, state: "ui_changed" };
      return { ...base, ids };
    }
    if (all("[data-work-browser-editor]").some((editor) => clean(editor.innerText) !== ""))
      return { ...base, state: "ui_changed" };
    const found = all(".c-message_kit__message, [data-testid='message_container']").filter(
      (row) =>
        clean(
          row.querySelector(".c-message_kit__text, [data-testid='message-text']")?.textContent,
        ) === input.text && !(input.previousIds as string[]).includes(rowId(row)),
    );
    if (
      found.length !== 1 ||
      !rowId(found[0]!) ||
      found[0]!.getAttribute("data-is-pending") === "true" ||
      found[0]!.querySelector(
        "[aria-busy='true'], [data-testid='message_sending'], [data-testid='message_send_failed']",
      )
    )
      return { ...base, state: "ui_changed" };
    if (
      !push({
        id: rowId(found[0]!),
        ref: "",
        kind: "message",
        text: String(input.text),
        author: null,
        subject: null,
        sourceUrl: pageUrl,
        timestamp: found[0]!.getAttribute("data-ts"),
      })
    )
      return { ...base, state: "ui_changed" };
    return base;
  }
  if (task === "calendar") {
    const viewedDate = all("[data-date]").some((el) => el.getAttribute("data-date") === input.date);
    const zone = all("[data-time-zone]").some(
      (el) => el.getAttribute("data-time-zone") === input.timeZone,
    );
    if (!viewedDate || !zone) return { ...base, state: "ui_changed" };
    const rows = all(
      "[data-calendar-event], [data-testid='calendar-event'], [data-automationid='CalendarEvent']",
    );
    if (
      rows.length === 0 &&
      !all("[data-testid='calendar-empty'], [aria-label*='Calendar']").length
    )
      return { ...base, state: "ui_changed" };
    for (const row of rows) {
      if (
        !push({
          id: rowId(row) || clean(row.innerText, 200),
          ref: "",
          kind: "event",
          text: clean(row.innerText),
          author: null,
          subject: clean(row.getAttribute("aria-label"), 1000) || null,
          sourceUrl: pageUrl,
          timestamp: row.getAttribute("data-start"),
        })
      )
        break;
    }
    base.more = true; // A rendered calendar is a partial view, not a complete account-wide export.
    return base;
  }
  if (task === "mailBody") {
    const bodies = all("[data-testid='message-body'], [role='document'], .allowTextSelection");
    if (bodies.length !== 1) return { ...base, state: "ui_changed" };
    const bodyText = bodies[0]!.innerText;
    base.more = bodyText.trim().length > 16000;
    if (
      !push({
        id: String(input.id),
        ref: "",
        kind: "mail",
        text: clean(bodyText),
        author:
          clean(document.querySelector("[data-testid='message-sender']")?.textContent, 500) || null,
        subject:
          clean(
            document.querySelector("[data-testid='message-subject'], [role='heading']")
              ?.textContent,
            1000,
          ) || null,
        sourceUrl: pageUrl,
        timestamp: null,
      })
    )
      return { ...base, state: "ui_changed" };
    return base;
  }
  const searchView =
    task === "searchRows"
      ? all(
          app === "slack"
            ? "[data-qa='search_view'], .p-search_results, .p-search_results__messages, [data-testid='search-results']"
            : "[data-testid='mail-search-results'], [aria-label='Search results'], [aria-label='Resultados de búsqueda']",
        )
      : [];
  if (task === "searchRows" && searchView.length === 0) return { ...base, state: "ui_changed" };
  if (task === "searchRows" && app === "slack") {
    const query = clean(document.querySelector(".p-top_nav__search__text")?.textContent);
    if (query !== `Search: ${input.query}`) return { ...base, state: "ui_changed" };
  }
  if (task === "searchRows" && app === "outlook") {
    const searches = all(
      "#topSearchInput, input[aria-label*='Search'], input[aria-label*='Buscar']",
    ) as HTMLInputElement[];
    if (searches.length !== 1 || searches[0]!.value !== input.query)
      return { ...base, state: "ui_changed" };
  }
  const selector =
    app === "slack"
      ? ".c-search_message, [data-testid='search_result'], .c-message_kit__message, [data-testid='message_container']"
      : "[data-convid], [data-item-id], [data-automationid='MessageListItem']";
  const rows = all(selector)
    .filter((row) => task !== "searchRows" || searchView.some((view) => view.contains(row)))
    .filter(
      (row, index, entries) =>
        !entries.some((other, otherIndex) => otherIndex !== index && other.contains(row)),
    );
  const ids = new Set<string>();
  for (const row of rows) {
    const timestampLink =
      app === "slack"
        ? row.querySelector<HTMLAnchorElement>("a.c-timestamp, a[data-qa='message_timestamp']")
        : null;
    let link =
      timestampLink?.href ??
      row.querySelector<HTMLAnchorElement>(
        "a[href*='/archives/'], a[href*='/client/'], a[href*='/mail/']",
      )?.href ??
      null;
    let id = rowId(row) || link;
    if (app === "slack" && timestampLink) {
      const permalink = new URL(timestampLink.href, pageUrl);
      const archive = /^\/archives\/(C[A-Z0-9]+)\/p(\d{7,})$/.exec(permalink.pathname);
      const team = /^\/client\/([TE][A-Z0-9]+)\//.exec(location.pathname)?.[1];
      if (
        archive &&
        team &&
        permalink.protocol === "https:" &&
        permalink.hostname.endsWith(".slack.com")
      ) {
        const ts = `${archive[2]!.slice(0, -6)}.${archive[2]!.slice(-6)}`;
        id = ts;
        link = `https://app.slack.com/client/${team}/${archive[1]}/thread/${archive[1]}-${ts}`;
      }
    }
    if (!id || ids.has(id)) continue;
    if (task === "message" && id !== input.id) continue;
    ids.add(id);
    if (
      !push({
        id,
        ref: "",
        kind: app === "slack" ? "message" : "mail",
        text: clean(
          row.querySelector(".c-message_kit__text, [data-testid='message-text']")?.textContent ??
            row.innerText,
        ),
        author:
          clean(
            row.querySelector(".c-message__sender, [data-testid='message-sender']")?.textContent,
            500,
          ) || null,
        subject:
          clean(row.querySelector("[data-testid='message-subject']")?.textContent, 1000) || null,
        sourceUrl: link ?? pageUrl,
        timestamp:
          row.querySelector("time")?.getAttribute("datetime") ?? row.getAttribute("data-ts"),
      })
    )
      break;
  }
  if (task === "message" && base.items.length !== 1) return { ...base, state: "ui_changed" };
  const emptyText =
    task === "searchRows"
      ? searchView.map((view) => view.innerText).join(" ")
      : document.body.innerText;
  if (
    rows.length === 0 &&
    !/no results|no messages|ningún resultado|no se encontraron/i.test(emptyText)
  )
    return { ...base, state: "ui_changed" };
  base.more = true;
  return base;
}

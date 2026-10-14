import * as Schema from "effect/Schema";
import type { Page } from "playwright-core";
import { slackPageRead } from "./SlackPageApi.ts";
import { SlackPageRequest, SlackPageResult } from "./readSchema.ts";
const decodeRequest = Schema.decodeUnknownSync(SlackPageRequest);
const decodeResult = Schema.decodeUnknownSync(SlackPageResult);
const encodeResult = Schema.encodeSync(SlackPageResult);

/** The browser owner executes a registered function with serialized arguments. */
export async function executeBrowserRead(page: Page, input: unknown): Promise<SlackPageResult> {
  let request: SlackPageRequest;
  try {
    request = decodeRequest(input);
  } catch {
    return { ok: false, code: "response_incompatible", status: 0 };
  }
  let raw: unknown;
  try {
    raw = await page.evaluate(slackPageRead, request);
  } catch {
    // Never propagate a page exception, payload or Playwright stack to the broker.
    return { ok: false, code: "origin_changed", status: 0 };
  }
  try {
    return encodeResult(decodeResult(raw));
  } catch {
    return { ok: false, code: "response_incompatible", status: 0 };
  }
}

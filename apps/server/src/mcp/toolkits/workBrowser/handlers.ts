import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as WorkBrowser from "../../../workBrowser/WorkBrowser.ts";
import * as Access from "../../McpToolAccess.ts";
import { WorkBrowserToolkit } from "./tools.ts";
import { WorkBrowserError, type Request } from "../../../workBrowser/schema.ts";

const isWorkBrowserError = Schema.is(WorkBrowserError);
const publicError = <E>(error: E) =>
  isWorkBrowserError(error) ? new WorkBrowserError({ code: error.code }) : error;
const run = (request: Request) =>
  WorkBrowser.WorkBrowser.pipe(
    Effect.flatMap((service) => service.run(request)),
    Effect.mapError(publicError),
  );
export const layer = Access.toLayer(WorkBrowserToolkit, {
  work_browser_configure: Access.writesEnvironment((input, check) =>
    WorkBrowser.WorkBrowser.pipe(
      Effect.flatMap((service) => check.pipe(Effect.andThen(service.configure(input)))),
      Effect.mapError(publicError),
    ),
  ),
  work_browser_status: Access.actsAsCaller((input) => run({ ...input, operation: "status" })),
  work_browser_resume: Access.actsAsCaller((input) => run({ ...input, operation: "resume" })),
  work_slack_search: Access.actsAsCaller((input) => run({ ...input, operation: "slackSearch" })),
  work_slack_read: Access.actsAsCaller((input) => run({ ...input, operation: "slackRead" })),
  work_slack_send: Access.actsAsCaller((input) => run({ ...input, operation: "slackSend" })),
  work_outlook_search: Access.actsAsCaller((input) => run({ ...input, operation: "mailSearch" })),
  work_outlook_read: Access.actsAsCaller((input) => run({ ...input, operation: "mailRead" })),
  work_outlook_send: Access.actsAsCaller((input) => run({ ...input, operation: "mailSend" })),
  work_calendar_list: Access.actsAsCaller((input) => run({ ...input, operation: "calendar" })),
});

import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfile, BrowserProfileId, BrowserProfileName } from "./browserProfile.ts";
import { PreviewTabId } from "./preview.ts";

export const RemoteBrowserInfo = Schema.Struct({
  available: Schema.Boolean,
  hostname: Schema.String,
  profiles: Schema.Array(BrowserProfile),
  defaultProfileId: BrowserProfileId,
});
export type RemoteBrowserInfo = typeof RemoteBrowserInfo.Type;

export const RemoteBrowserProfileInput = Schema.Struct({
  id: Schema.optional(BrowserProfileId),
  name: BrowserProfileName,
});
export type RemoteBrowserProfileInput = typeof RemoteBrowserProfileInput.Type;

export const RemoteBrowserTarget = Schema.Struct({ threadId: ThreadId, tabId: PreviewTabId });
export type RemoteBrowserTarget = typeof RemoteBrowserTarget.Type;

const ViewerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const RemoteBrowserStreamInput = Schema.Struct({
  ...RemoteBrowserTarget.fields,
  viewerId: ViewerId,
});
export const RemoteBrowserControlInput = Schema.Struct({
  ...RemoteBrowserTarget.fields,
  viewerId: ViewerId,
  action: Schema.Literals(["acquire", "release", "heartbeat"]),
});
export type RemoteBrowserControlInput = typeof RemoteBrowserControlInput.Type;

export const RemoteBrowserControl = Schema.Struct({
  controller: Schema.NullOr(ViewerId),
  expiresAt: Schema.NullOr(Schema.Number),
});
export type RemoteBrowserControl = typeof RemoteBrowserControl.Type;

const Coordinate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const RemoteBrowserAction = Schema.Union([
  Schema.TaggedStruct("navigate", { url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)) }),
  Schema.TaggedStruct("reload", {}),
  Schema.TaggedStruct("record", { action: Schema.Literals(["start", "stop"]) }),
  Schema.TaggedStruct("pointer", {
    phase: Schema.Literals(["move", "down", "up"]),
    x: Coordinate,
    y: Coordinate,
    button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
    clickCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  }),
  Schema.TaggedStruct("wheel", { deltaX: Schema.Finite, deltaY: Schema.Finite }),
  Schema.TaggedStruct("key", { key: TrimmedNonEmptyString.check(Schema.isMaxLength(128)) }),
  Schema.TaggedStruct("text", { text: Schema.String.check(Schema.isMaxLength(64_000)) }),
  Schema.TaggedStruct("history", { direction: Schema.Literals(["back", "forward"]) }),
  Schema.TaggedStruct("dialog", {
    accept: Schema.Boolean,
    promptText: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("upload", {
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
    mimeType: Schema.String.check(Schema.isMaxLength(128)),
    data: Schema.String.check(Schema.isMaxLength(22_400_000)),
  }),
]);
export type RemoteBrowserAction = typeof RemoteBrowserAction.Type;

export const RemoteBrowserInput = Schema.Struct({
  ...RemoteBrowserTarget.fields,
  viewerId: ViewerId,
  action: RemoteBrowserAction,
});
export type RemoteBrowserInput = typeof RemoteBrowserInput.Type;

export const RemoteBrowserDownload = Schema.Struct({
  attachmentId: Schema.String,
  name: Schema.String,
  sizeBytes: Schema.Number,
});
export type RemoteBrowserDownload = typeof RemoteBrowserDownload.Type;

export const RemoteBrowserFrame = Schema.Struct({
  ...RemoteBrowserTarget.fields,
  sequence: Schema.Number,
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  controller: Schema.NullOr(ViewerId),
  dialog: Schema.optional(Schema.Struct({ type: Schema.String, message: Schema.String })),
  fileChooser: Schema.optional(Schema.Boolean),
  downloads: Schema.optional(Schema.Array(RemoteBrowserDownload)),
  recording: Schema.optional(Schema.Boolean),
});
export type RemoteBrowserFrame = typeof RemoteBrowserFrame.Type;

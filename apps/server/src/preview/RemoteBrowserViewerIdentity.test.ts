import { describe, expect, it } from "vite-plus/test";
import {
  remoteBrowserViewerIdentity,
  remoteBrowserVisibleController,
} from "./RemoteBrowserViewerIdentity.ts";

describe("remote browser viewer authorization", () => {
  it("binds control to an authenticated session even if another viewer copies its public ID", () => {
    const owner = remoteBrowserViewerIdentity("owner-session", "copied-viewer-id");
    const observer = remoteBrowserViewerIdentity("read-only-session", "copied-viewer-id");
    expect(observer).not.toBe(owner);
    expect(remoteBrowserVisibleController(owner, observer, "copied-viewer-id")).toBe(
      "another-viewer",
    );
    expect(remoteBrowserVisibleController(owner, owner, "copied-viewer-id")).toBe(
      "copied-viewer-id",
    );
  });
});

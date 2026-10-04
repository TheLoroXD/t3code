import * as NodeCrypto from "node:crypto";

/** A read-only viewer cannot impersonate a controller by copying its public viewer ID. */
export function remoteBrowserViewerIdentity(sessionId: string, viewerId: string): string {
  return NodeCrypto.createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(viewerId)
    .digest("hex");
}

export function remoteBrowserVisibleController(
  controller: string | null,
  identity: string,
  viewerId: string,
): string | null {
  return controller === null ? null : controller === identity ? viewerId : "another-viewer";
}

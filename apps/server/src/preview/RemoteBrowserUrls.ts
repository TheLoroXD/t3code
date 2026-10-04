import { PreviewRemoteBrowserError } from "@t3tools/contracts";

/** Signed assets must use the environment's port, not a client's SSH-forwarded origin. */
export function resolveRemoteAssetUrl(relativeUrl: string, port: number): string {
  const origin = `http://127.0.0.1:${port}`;
  const destination = new URL(relativeUrl, origin);
  if (
    !relativeUrl.startsWith("/api/assets/") ||
    relativeUrl.includes("\\") ||
    destination.origin !== origin ||
    !destination.pathname.startsWith("/api/assets/")
  ) {
    throw new PreviewRemoteBrowserError({ reason: "input" });
  }
  return destination.href;
}

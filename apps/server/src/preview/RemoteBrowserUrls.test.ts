import { describe, expect, it } from "vite-plus/test";
import { resolveRemoteAssetUrl } from "./RemoteBrowserUrls.ts";

describe("environment browser assets", () => {
  it("uses the host's listener instead of a client forwarding port", () => {
    expect(resolveRemoteAssetUrl("/api/assets/signed-token/report.html", 3789)).toBe(
      "http://127.0.0.1:3789/api/assets/signed-token/report.html",
    );
  });
  it("rejects external origins and traversal out of the signed asset route", () => {
    for (const url of [
      "https://example.com/api/assets/token/file",
      "//example.com/api/assets/token/file",
      "/api/assets/../../admin",
      "/api/assets/%2e%2e/%2e%2e/admin",
      "/api/assets/\\\\example.com/file",
    ]) {
      expect(() => resolveRemoteAssetUrl(url, 3789)).toThrow();
    }
  });
});

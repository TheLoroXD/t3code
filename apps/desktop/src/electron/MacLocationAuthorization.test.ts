import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ status: 0, requests: 0 }));
vi.mock("ffi-rs", () => ({
  DataType: { BigInt: 16, String: 0, I32: 1, Void: 7 },
  open: () => {},
  load: ({ retType }: { retType: number }) => {
    if (retType === 1) return native.status;
    if (retType === 7) {
      native.requests += 1;
      return undefined;
    }
    return 1n;
  },
}));

import { requestMacLocationAuthorization } from "./MacLocationAuthorization.ts";

describe("macOS location authorization", () => {
  beforeEach(() => {
    native.status = 0;
    native.requests = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([3, 4])("accepts existing authorization %s without another prompt", async (status) => {
    native.status = status;
    expect(await requestMacLocationAuthorization()).toBe(true);
    expect(native.requests).toBe(0);
  });

  it.each([1, 2])(
    "returns restricted or denied authorization %s without prompting",
    async (status) => {
      native.status = status;
      expect(await requestMacLocationAuthorization()).toBe(false);
      expect(native.requests).toBe(0);
    },
  );

  it("waits for macOS authorization before allowing location acquisition", async () => {
    const outcome = vi.fn();
    const request = requestMacLocationAuthorization().then(outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.requests).toBe(1);
    expect(outcome).not.toHaveBeenCalled();

    native.status = 3;
    await vi.advanceTimersByTimeAsync(250);
    await request;
    expect(outcome).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares a pending system prompt and applies denial to all waiting requests", async () => {
    const first = requestMacLocationAuthorization();
    const second = requestMacLocationAuthorization();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.requests).toBe(1);

    native.status = 2;
    await vi.advanceTimersByTimeAsync(250);
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("denies an unanswered system prompt and releases its timers", async () => {
    const request = requestMacLocationAuthorization();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await request).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

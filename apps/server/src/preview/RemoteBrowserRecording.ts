import * as NodeCrypto from "node:crypto";
import { Cause, Clock, Effect, Exit, Fiber, FileSystem, Path, Queue, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { PreviewRemoteBrowserError } from "@t3tools/contracts";
import type { BrowserFrame } from "./RemoteBrowserRuntime.ts";

export interface RemoteVideoRecorder {
  readonly stop: () => Promise<Buffer>;
  readonly dispose: () => Promise<void>;
}

/** Encodes bounded, constant-rate copies of CDP frames without depending on a viewer. */
export async function startRemoteBrowserRecording(options: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly clock: Clock.Clock;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly root: string;
  readonly platform: NodeJS.Platform;
  readonly frame: () => BrowserFrame | undefined;
}): Promise<RemoteVideoRecorder> {
  const { fileSystem, path, spawner } = options;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (options.platform === "darwin"
      ? path.join(home, "Library", "Caches", "ms-playwright")
      : options.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? home, "ms-playwright")
        : path.join(home, ".cache", "ms-playwright"));
  const directories = await Effect.runPromise(
    fileSystem.readDirectory(cache).pipe(Effect.orElseSucceed(() => [])),
  );
  const candidates = [
    process.env.T3CODE_BROWSER_FFMPEG_PATH,
    ...directories
      .filter((entry) => entry.startsWith("ffmpeg-"))
      .toSorted()
      .toReversed()
      .map((directory) =>
        path.join(
          cache,
          directory,
          options.platform === "darwin"
            ? "ffmpeg-mac"
            : options.platform === "win32"
              ? "ffmpeg-win64.exe"
              : "ffmpeg-linux",
        ),
      ),
  ];
  let executable: string | undefined;
  for (const candidate of candidates)
    if (candidate && (await Effect.runPromise(fileSystem.exists(candidate)))) {
      executable = candidate;
      break;
    }
  if (!executable) throw new PreviewRemoteBrowserError({ reason: "unsupported" });
  await Effect.runPromise(fileSystem.makeDirectory(options.root, { recursive: true, mode: 0o700 }));
  const destination = path.join(options.root, `${NodeCrypto.randomUUID()}.webm`);
  const scope = Effect.runSync(Scope.make());
  const dispose = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Effect.runPromise(fileSystem.remove(destination).pipe(Effect.ignore));
  };
  try {
    const child = await Effect.runPromise(
      spawner
        .spawn(
          ChildProcess.make(
            executable,
            [
              "-loglevel",
              "error",
              "-f",
              "image2pipe",
              "-vcodec",
              "mjpeg",
              "-framerate",
              "10",
              "-i",
              "pipe:0",
              "-an",
              "-c:v",
              "vp8",
              "-b:v",
              "1M",
              "-fs",
              "52428800",
              "-y",
              destination,
            ],
            { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
          ),
        )
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const frames = Effect.runSync(Queue.dropping<Uint8Array, Cause.Done>(4));
    const initial = options.frame();
    if (initial) Effect.runSync(Queue.offer(frames, Buffer.from(initial.data, "base64")));
    const writer = Effect.runPromise(Stream.run(Stream.fromQueue(frames), child.stdin));
    void writer.catch(() => undefined);
    const sampler = await Effect.runPromise(
      Stream.tick("100 millis").pipe(
        Stream.map(() => options.frame()),
        Stream.filter((frame) => frame !== undefined),
        Stream.runForEach((frame) => Queue.offer(frames, Buffer.from(frame.data, "base64"))),
        Effect.forkIn(scope),
        Effect.provideService(Clock.Clock, options.clock),
      ),
    );
    return {
      dispose,
      stop: async () => {
        try {
          await Effect.runPromise(Fiber.interrupt(sampler));
          await Effect.runPromise(Queue.end(frames));
          await writer;
          const code = await Effect.runPromise(child.exitCode.pipe(Effect.timeout("20 seconds")));
          if (code !== 0) throw new PreviewRemoteBrowserError({ reason: "failed" });
          const bytes = await Effect.runPromise(fileSystem.readFile(destination));
          if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024)
            throw new PreviewRemoteBrowserError({ reason: "input" });
          return Buffer.from(bytes);
        } finally {
          await dispose();
        }
      },
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

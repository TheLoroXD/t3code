import { createPreviewAutomationClientId } from "./previewAutomationClientId";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { RemoteBrowserAction, RemoteBrowserFrame, ScopedThreadRef } from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type PointerEvent,
} from "react";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { downloadMedia } from "~/components/media/mediaContent";

export interface RemoteBrowserViewHandle {
  readonly dispatch: (action: RemoteBrowserAction) => Promise<boolean>;
}

function StreamView({
  threadRef,
  tabId,
  controlRef,
}: {
  threadRef: ScopedThreadRef;
  tabId: string;
  controlRef?: Ref<RemoteBrowserViewHandle> | undefined;
}) {
  const [viewerId] = useState(createPreviewAutomationClientId);
  const streamAtom = previewEnvironment.remoteFrames({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, tabId, viewerId },
  });
  const result = useAtomValue(streamAtom);
  const reconnectStream = useAtomRefresh(streamAtom);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const input = useAtomCommand(previewEnvironment.remoteInput);
  const control = useAtomCommand(previewEnvironment.remoteControl);
  const frame = result._tag === "Success" ? result.value : null;
  const [lastFrame, setLastFrame] = useState<RemoteBrowserFrame | null>(null);
  const [ownsControl, setOwnsControl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptText, setPromptText] = useState("");
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const composing = useRef(false);
  const pointerMoveAt = useRef(0);
  const shownFrame = frame ?? lastFrame;
  const target = useMemo(
    () => ({ threadId: threadRef.threadId, tabId, viewerId }),
    [threadRef.threadId, tabId, viewerId],
  );

  if (frame && frame !== lastFrame) {
    setLastFrame(frame);
    setOwnsControl(frame.controller === viewerId);
  }
  useEffect(() => {
    if (!ownsControl) return;
    const heartbeat = window.setInterval(() => {
      void control({
        environmentId: threadRef.environmentId,
        input: { ...target, action: "heartbeat" },
      }).then((response) => {
        if (response._tag === "Failure") setOwnsControl(false);
      });
    }, 10_000);
    return () => window.clearInterval(heartbeat);
  }, [control, ownsControl, target, threadRef.environmentId]);

  const setControl = async (acquire: boolean) => {
    const response = await control({
      environmentId: threadRef.environmentId,
      input: { ...target, action: acquire ? "acquire" : "release" },
    });
    if (response._tag === "Success") {
      setOwnsControl(response.value.controller === viewerId);
      setError(null);
      if (acquire) keyboard.current?.focus();
    } else setError("Unable to take control. Another viewer may be controlling this browser.");
  };
  const send = useCallback(
    (action: RemoteBrowserAction) => {
      if (!ownsControl) return;
      void input({
        environmentId: threadRef.environmentId,
        input: { ...target, action },
      }).then((response) => {
        if (response._tag === "Failure") {
          setError("The browser did not confirm this action. It was not retried.");
        }
      });
    },
    [input, ownsControl, target, threadRef.environmentId],
  );

  useImperativeHandle(
    controlRef,
    () => ({
      dispatch: async (action) => {
        if (!ownsControl) {
          const lease = await control({
            environmentId: threadRef.environmentId,
            input: { ...target, action: "acquire" },
          });
          if (lease._tag === "Failure") {
            setError("Another viewer controls this browser.");
            return false;
          }
          setOwnsControl(true);
        }
        const response = await input({
          environmentId: threadRef.environmentId,
          input: { ...target, action },
        });
        if (response._tag === "Failure")
          setError("The browser did not confirm this action. It was not retried.");
        if (response._tag === "Success" && result._tag === "Failure") reconnectStream();
        return response._tag === "Success";
      },
    }),
    [control, input, ownsControl, reconnectStream, result._tag, threadRef.environmentId],
  );

  const pointer = (event: PointerEvent<HTMLImageElement>, phase: "move" | "down" | "up") => {
    if (!shownFrame || !ownsControl) return;
    if (phase === "move" && Date.now() - pointerMoveAt.current < 50) return;
    pointerMoveAt.current = Date.now();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(shownFrame.width - 1, ((event.clientX - rect.left) / rect.width) * shownFrame.width),
    );
    const y = Math.max(
      0,
      Math.min(
        shownFrame.height - 1,
        ((event.clientY - rect.top) / rect.height) * shownFrame.height,
      ),
    );
    if (phase === "down") {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      keyboard.current?.focus();
    }
    send({
      _tag: "pointer",
      phase,
      x,
      y,
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
      clickCount: 1,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-remote-browser-tab={tabId}>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="flex-1 text-xs text-muted-foreground">
          {result._tag === "Failure"
            ? "Disconnected · tab stays on host"
            : ownsControl
              ? "You control this browser"
              : shownFrame?.controller
                ? "Another viewer controls this browser"
                : "Agent can use this browser"}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void setControl(!ownsControl)}
          disabled={result._tag === "Failure"}
        >
          {ownsControl ? "Release control" : "Take control"}
        </Button>
        {ownsControl ? (
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            Upload file
          </Button>
        ) : null}
        {ownsControl ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              send({ _tag: "record", action: shownFrame?.recording ? "stop" : "start" })
            }
          >
            {shownFrame?.recording ? "Stop recording" : "Record"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {shownFrame?.dialog ? (
        <div className="flex items-center gap-2 border-b p-3">
          <span className="flex-1 text-sm">{shownFrame.dialog.message}</span>
          {shownFrame.dialog.type === "prompt" ? (
            <input
              aria-label="Browser prompt response"
              className="rounded border p-1"
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
              disabled={!ownsControl}
            />
          ) : null}
          <Button
            size="sm"
            disabled={!ownsControl}
            onClick={() => send({ _tag: "dialog", accept: true, promptText })}
          >
            Accept
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!ownsControl}
            onClick={() => send({ _tag: "dialog", accept: false })}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {shownFrame?.downloads?.length ? (
        <div className="flex flex-wrap gap-2 border-b px-3 py-2">
          {shownFrame.downloads.map((download) => (
            <Button
              key={download.attachmentId}
              variant="outline"
              size="sm"
              onClick={() => {
                void (async () => {
                  const connection = readPreparedConnection(threadRef.environmentId);
                  if (!connection) throw new Error("Reconnect to download this file.");
                  const resource = {
                    _tag: "attachment" as const,
                    attachmentId: download.attachmentId,
                    fileName: download.name,
                    disposition: "attachment" as const,
                  };
                  const asset = await createAssetUrl({
                    environmentId: threadRef.environmentId,
                    input: { resource },
                  });
                  if (asset._tag !== "Success")
                    throw new Error("The host could not prepare this download.");
                  const url = resolveAssetUrl(connection.httpBaseUrl, asset.value.relativeUrl);
                  if (!url) throw new Error("The host returned an invalid download URL.");
                  await downloadMedia(url, download.name);
                })().catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : "Download failed."),
                );
              }}
            >
              Download {download.name}
            </Button>
          ))}
        </div>
      ) : null}
      {shownFrame?.fileChooser ? (
        <p role="status" className="px-3 py-2 text-sm">
          The page requested a file. Take control and choose Upload file.
        </p>
      ) : null}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30">
        {shownFrame ? (
          <img
            ref={image}
            src={`data:image/jpeg;base64,${shownFrame.data}`}
            alt="Live remote browser"
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
            onPointerDown={(event) => pointer(event, "down")}
            onPointerUp={(event) => pointer(event, "up")}
            onPointerMove={(event) => pointer(event, "move")}
            onContextMenu={(event) => event.preventDefault()}
            onWheel={(event) => {
              if (ownsControl) {
                event.preventDefault();
                send({ _tag: "wheel", deltaX: event.deltaX, deltaY: event.deltaY });
              }
            }}
          />
        ) : (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            {result._tag === "Failure"
              ? "The remote browser is unavailable. Reconnect to the host to return to this session."
              : "Connecting to the browser stream…"}
          </p>
        )}
        <textarea
          ref={keyboard}
          className="absolute left-0 top-0 h-px w-px opacity-0"
          aria-label="Remote browser keyboard input"
          autoComplete="off"
          spellCheck={false}
          disabled={!ownsControl}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            if (event.data) send({ _tag: "text", text: event.data });
            event.currentTarget.value = "";
          }}
          onInput={(event) => {
            if (!composing.current && event.currentTarget.value) {
              send({ _tag: "text", text: event.currentTarget.value });
              event.currentTarget.value = "";
            }
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.key === "Process" ||
              ["Shift", "Control", "Alt", "Meta"].includes(event.key)
            )
              return;
            if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
            event.preventDefault();
            const key = event.key === " " ? "Space" : event.key;
            send({
              _tag: "key",
              key: [
                ...(event.ctrlKey || event.metaKey ? ["Control"] : []),
                ...(event.altKey ? ["Alt"] : []),
                ...(event.shiftKey ? ["Shift"] : []),
                key,
              ].join("+"),
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            if (text) send({ _tag: "text", text });
          }}
        />
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          aria-label="Upload to remote browser"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            if (file.size > 16_000_000) {
              setError("Files must be smaller than 16 MB.");
              return;
            }
            const reader = new FileReader();
            reader.addEventListener("load", () => {
              if (typeof reader.result === "string")
                send({
                  _tag: "upload",
                  name: file.name,
                  mimeType: file.type,
                  data: reader.result.split(",", 2)[1] ?? "",
                });
            });
            reader.readAsDataURL(file);
          }}
        />
      </div>
    </div>
  );
}

export function RemoteBrowserView({
  threadRef,
  tabId,
  visible,
  controlRef,
}: {
  threadRef: ScopedThreadRef;
  tabId: string;
  visible: boolean;
  controlRef?: Ref<RemoteBrowserViewHandle> | undefined;
}) {
  return visible ? (
    <StreamView key={tabId} threadRef={threadRef} tabId={tabId} controlRef={controlRef} />
  ) : null;
}

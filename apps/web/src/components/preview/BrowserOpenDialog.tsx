import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { create } from "zustand";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import {
  browserHostPreference,
  useBrowserHostPreferences,
  type BrowserHostPreference,
} from "~/browser/browserHostPreferences";
import { isElectron } from "~/env";
import { useEnvironment } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "~/components/ui/select";

interface Request {
  readonly threadRef: ScopedThreadRef;
  readonly profileId?: string | undefined;
  readonly resolve: (choice: BrowserHostPreference | null) => void;
}
const useBrowserOpenRequests = create<{ readonly pending: Request | null }>(() => ({
  pending: null,
}));

export function chooseBrowserHost(
  threadRef: ScopedThreadRef,
  profileId?: string,
): Promise<BrowserHostPreference | null> {
  useBrowserOpenRequests.getState().pending?.resolve(null);
  return new Promise((resolve) =>
    useBrowserOpenRequests.setState({ pending: { threadRef, profileId, resolve } }),
  );
}

function BrowserHostForm({ request }: { request: Request }) {
  const environment = useEnvironment(request.threadRef.environmentId);
  const remote = useAtomValue(
    previewEnvironment.remoteInfo({ environmentId: request.threadRef.environmentId, input: {} }),
  );
  const refreshProfiles = useAtomRefresh(
    previewEnvironment.remoteInfo({ environmentId: request.threadRef.environmentId, input: {} }),
  );
  const saveProfile = useAtomCommand(previewEnvironment.remoteProfile);
  const [newProfileName, setNewProfileName] = useState("");
  const [addingProfile, setAddingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const defaults = useBrowserDefaults();
  const [host, setHost] = useState(browserHostPreference(request.threadRef.environmentId).host);
  const [profileId, setProfileId] = useState(request.profileId);
  const details = remote._tag === "Success" ? remote.value : null;
  const profiles = host === "client" ? defaults.profiles : (details?.profiles ?? []);
  const selectedProfile = profiles.some((profile) => profile.id === profileId)
    ? profileId
    : host === "client"
      ? defaults.profileId
      : details?.defaultProfileId;
  const available = host === "client" ? isElectron : details?.available === true;
  const finish = (choice: BrowserHostPreference | null) => {
    if (choice) useBrowserHostPreferences.getState().set(request.threadRef.environmentId, choice);
    useBrowserOpenRequests.setState({ pending: null });
    request.resolve(choice);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Open browser</DialogTitle>
          <DialogDescription>
            Choose where the browser runs and which profile it uses.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 py-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="browser-host-choice">
              Host
            </label>
            <Select
              value={host}
              onValueChange={(value) => {
                if (value === "client" || value === "environment") {
                  setHost(value);
                  setProfileId(undefined);
                }
              }}
            >
              <SelectTrigger id="browser-host-choice" aria-label="Browser host">
                <SelectValue>
                  {host === "client"
                    ? "This Mac · local browser"
                    : `${environment?.label ?? details?.hostname ?? "Project host"} · streaming`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {isElectron ? (
                  <SelectItem value="client">This Mac · local browser</SelectItem>
                ) : null}
                <SelectItem value="environment">
                  {environment?.label ?? details?.hostname ?? "Project host"} · streaming
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="browser-profile-choice">
              Profile
            </label>
            <Select
              value={selectedProfile ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string") setProfileId(value);
              }}
            >
              <SelectTrigger id="browser-profile-choice" aria-label="Browser profile">
                <SelectValue>
                  {profiles.find((profile) => profile.id === selectedProfile)?.name ??
                    "Connecting…"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          {host === "environment" ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Input
                  aria-label="New host profile name"
                  placeholder="New profile name"
                  maxLength={48}
                  value={newProfileName}
                  onChange={(event) => setNewProfileName(event.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={!newProfileName.trim() || addingProfile}
                  onClick={async () => {
                    setAddingProfile(true);
                    setProfileError(null);
                    const result = await saveProfile({
                      environmentId: request.threadRef.environmentId,
                      input: { name: newProfileName.trim() },
                    });
                    setAddingProfile(false);
                    if (result._tag === "Success") {
                      setProfileId(
                        result.value.profiles.findLast(
                          (profile) => profile.name === newProfileName.trim(),
                        )?.id,
                      );
                      setNewProfileName("");
                      refreshProfiles();
                    } else setProfileError("Unable to create this profile on the host.");
                  }}
                >
                  Add profile
                </Button>
              </div>
              {profileError ? (
                <p role="alert" className="text-sm text-destructive">
                  {profileError}
                </p>
              ) : null}
            </div>
          ) : null}
          {host === "environment" ? (
            <p className="text-sm text-muted-foreground">
              This browser and its profiles stay on the host. Closing the viewer keeps its tabs
              running.
            </p>
          ) : null}
          {host === "environment" && !available ? (
            <p role="status" className="text-sm text-muted-foreground">
              {remote._tag === "Failure"
                ? "This host does not provide a remote browser."
                : details
                  ? "Chromium is unavailable on this host."
                  : "Connecting to the browser host…"}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            disabled={!available || !selectedProfile}
            onClick={() => finish({ host, profileId: selectedProfile })}
          >
            Open browser
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BrowserOpenDialog() {
  const pending = useBrowserOpenRequests((state) => state.pending);
  return pending ? <BrowserHostForm key={pending.threadRef.threadId} request={pending} /> : null;
}

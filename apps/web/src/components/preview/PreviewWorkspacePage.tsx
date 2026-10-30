import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { MaximizeIcon, MinimizeIcon, XIcon } from "lucide-react";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { toastManager } from "~/components/ui/toast";
import { useNavigateToMainApp } from "~/components/sidebar/mainAppLocation";
import { isElectron } from "~/env";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { PreviewView } from "./PreviewView";

export function PreviewWorkspacePage({
  environmentId,
  threadId,
  tabId,
}: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly tabId?: string;
}) {
  const navigate = useNavigate();
  const returnToChat = useNavigateToMainApp();
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Follow fullscreen changes from the browser or Escape as well as the toggle button.
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const leave = async (minimize: boolean) => {
    // Leaving the workspace must not wait for the native fullscreen transition.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    if (minimize && environmentId && threadId && tabId) {
      usePreviewMiniPlayerStore
        .getState()
        .open({ environmentId, threadId }, browserMiniPlayerSource(tabId));
    }
    if (environmentId && threadId) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
        replace: true,
      });
    } else {
      await returnToChat();
    }
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to enter fullscreen",
        description: error instanceof Error ? error.message : "Try maximizing the T3 window.",
      });
    }
  };
  return (
    <main
      className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-background"
      aria-label="Browser workspace"
    >
      <WorkspacePageHeader
        electron={isElectron}
        reserveNativeControls
        className="border-b pl-(--workspace-controls-left)!"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Browser preview</span>
        <div
          className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]"
          role="group"
          aria-label="Preview window controls"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                  onClick={() => void toggleFullscreen()}
                />
              }
            >
              <MaximizeIcon />
            </TooltipTrigger>
            <TooltipPopup>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Minimize preview"
                  onClick={() => void leave(true)}
                />
              }
            >
              <MinimizeIcon />
            </TooltipTrigger>
            <TooltipPopup>Minimize preview</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Return to chat"
                  onClick={() => void leave(false)}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup>Return to chat</TooltipPopup>
          </Tooltip>
        </div>
      </WorkspacePageHeader>
      {environmentId && threadId && tabId ? (
        <PreviewView threadRef={{ environmentId, threadId }} tabId={tabId} visible />
      ) : (
        <div className="p-6 text-sm text-muted-foreground">This preview is unavailable.</div>
      )}
    </main>
  );
}

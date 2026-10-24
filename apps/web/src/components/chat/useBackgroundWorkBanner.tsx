import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";
import { useState } from "react";
import { BackgroundWorkDetails } from "./BackgroundWorkDetails";
import {
  BackgroundWorkDrawer,
  BackgroundWorkDrawerToggle,
  useBackgroundWorkHistory,
} from "./BackgroundWorkDrawer";
import {
  backgroundWorkOutputTaskIds,
  finishedBackgroundWorkTitle,
  type BackgroundWorkEntry,
} from "./BackgroundWorkDrawer.logic";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { backgroundWorkBannerItem } from "./ThreadActivityBanners";

export function useBackgroundWorkBanner(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly tasks: Parameters<typeof backgroundWorkBannerItem>[0]["tasks"];
  readonly providerThreads: Parameters<typeof backgroundWorkOutputTaskIds>[0];
  readonly latestRunId: string | null;
  readonly settled: boolean;
  readonly stopDisabled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const presentation = presentPendingBackgroundWork(input.tasks);
  const outputIds = backgroundWorkOutputTaskIds(input.providerThreads);
  const running = (presentation?.items ?? []).map((item): BackgroundWorkEntry => ({
    ...item,
    hasOutput: outputIds.has(item.taskId),
  }));
  const key = input.threadId === null ? null : `${input.environmentId}:${input.threadId}`;
  const history = useBackgroundWorkHistory({
    key,
    running,
    latestRunId: input.latestRunId,
    settled: input.settled,
  });
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const expanded = key !== null && expandedKey === key;
  const finished = input.settled ? history.finished : [];
  if (input.threadId === null || (presentation === null && finished.length === 0)) return null;
  const toggle = (
    <BackgroundWorkDrawerToggle
      expanded={expanded}
      onToggle={() => setExpandedKey((current) => (current === key ? null : key))}
    />
  );
  const drawer = expanded ? (
    <BackgroundWorkDrawer
      environmentId={input.environmentId}
      threadId={input.threadId}
      running={running}
      finished={finished}
      onOpenThread={input.onOpenThread}
      onRead={history.markRead}
    />
  ) : undefined;
  const base = backgroundWorkBannerItem({ ...input, threadId: input.threadId });
  if (base === null)
    return {
      id: `background-work:${input.threadId}`,
      variant: "default",
      priority: "activity",
      icon: <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />,
      title: finishedBackgroundWorkTitle(finished),
      actions: toggle,
      children: drawer,
    } satisfies ComposerBannerStackItem;
  return {
    ...base,
    details: (
      <BackgroundWorkDetails items={presentation?.items ?? []} onOpenThread={input.onOpenThread} />
    ),
    actions: (
      <>
        {toggle}
        {base.actions}
      </>
    ),
    children: drawer,
  } satisfies ComposerBannerStackItem;
}

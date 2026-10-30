import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopedProjectKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ThreadId, TodoBoardCard } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ExpandIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ListTodoIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { readLocalApi } from "~/localApi";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useServerConfigs } from "~/state/entities";
import { projectEnvironment, projectTodoBoard } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { toastManager } from "~/components/ui/toast";
import { TaskAgentsDialog } from "./TaskAgentsDialog";
import { canStartTaskAgent } from "./taskAgentsLogic";
import {
  countLabel,
  filteredTasks,
  TASK_STATUS_ORDER,
  taskAreas,
  taskExcerpt,
  taskStatusCounts,
  taskStatusLabel,
  withTaskSource,
  type TaskFilters,
  type TaskView,
} from "./taskBoardLogic";
import {
  taskBoardScrollTop,
  useTaskBoard,
  useTaskBoardStore,
  type TaskBoardState,
} from "./taskBoardStore";

interface TasksPanelProps {
  project: EnvironmentProject;
  visible?: boolean;
  onUseInChat: (card: TodoBoardCard) => void;
  onExpand?: (() => void) | undefined;
}

interface TaskFile {
  projectKey: string;
  root: string;
  path: string;
  /** An older note reads from the board; a card reads its file. */
  note: string | null;
}

/** An area or pack name on one line, cut with an ellipsis; the tooltip has all of it. */
function TaskLabel(props: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="min-w-0 max-w-full truncate" />}>
        {props.text}
      </TooltipTrigger>
      <TooltipPopup>{props.text}</TooltipPopup>
    </Tooltip>
  );
}

/** A table action: labeled when the board is wide, only its icon when narrow (the panel). */
function TaskAction(props: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            aria-label={props.label}
            onClick={props.onClick}
            disabled={props.disabled}
          />
        }
      >
        {props.icon}
        <span className="@max-2xl:hidden">{props.label}</span>
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** A card's file (or an older note) rendered, in place of the board until it closes. */
function TaskFileReader(props: {
  project: EnvironmentProject;
  file: TaskFile;
  onClose: () => void;
}) {
  const { file } = props;
  const contents = useEnvironmentQuery(
    file.note === null
      ? projectEnvironment.readFile({
          environmentId: props.project.environmentId,
          input: { cwd: file.root, relativePath: file.path },
        })
      : null,
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <Button variant="ghost" size="xs" onClick={props.onClose}>
          <ListTodoIcon />
          Tasks
        </Button>
        <FileTextIcon className="size-3.5" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        <Button variant="ghost" size="icon-xs" aria-label="Close card file" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {file.note === null && contents.isPending ? (
          <Spinner />
        ) : file.note === null && contents.error ? (
          <p role="alert" className="text-sm text-destructive">
            {contents.error}
          </p>
        ) : (
          <>
            {file.note === null && contents.data?.truncated ? (
              <p role="status" className="mb-3 text-sm text-warning-foreground">
                This file is too large to display in full.
              </p>
            ) : null}
            <ChatMarkdown
              text={file.note ?? contents.data?.contents ?? ""}
              cwd={file.root}
              environmentId={props.project.environmentId}
            />
          </>
        )}
      </div>
    </div>
  );
}

function TaskFilter(props: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value}
      items={props.options}
      onValueChange={(value) => props.onChange(value ?? "")}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {props.options.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function TaskCard(props: {
  card: TodoBoardCard;
  selected: boolean;
  onToggle: () => void;
  onUse: () => void;
  onOpen: () => void;
  onStart: () => void;
}) {
  const card = props.card;
  const startable = canStartTaskAgent(card);
  const excerpt = taskExcerpt(card);
  return (
    <article className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={props.selected}
          disabled={!startable}
          onCheckedChange={props.onToggle}
          aria-label={`Select ${card.id}`}
        />
        <span className="min-w-0 flex-1 break-all font-mono">{card.id}</span>
        <span className="shrink-0">{[card.pri, card.size].filter(Boolean).join(" · ") || "–"}</span>
      </div>
      <button
        type="button"
        className="text-left text-sm font-medium hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        onClick={props.onOpen}
        disabled={card.origin_only}
      >
        {card.title}
      </button>
      {excerpt ? <p className="line-clamp-2 text-xs text-muted-foreground">{excerpt}</p> : null}
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <TaskLabel text={card.area} />
        {card.pack ? <TaskLabel text={card.pack} /> : null}
        {card.kind === "note" ? <span>Older note</span> : null}
      </div>
      {card.branch ? (
        <div className="break-all font-mono text-xs text-muted-foreground">
          {card.branch.branch}
          {card.branch.tip_status ? ` · ${card.branch.tip_status}` : ""}
        </div>
      ) : null}
      {card.stale || card.origin_only || card.origin_status ? (
        <div className="flex flex-wrap gap-2 text-xs text-warning-foreground">
          {card.stale ? <span>Stale claim</span> : null}
          {card.origin_only ? <span>Origin only</span> : null}
          {card.origin_status ? <span>Origin: {taskStatusLabel(card.origin_status)}</span> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="xs" onClick={props.onUse}>
          <MessageSquareIcon />
          Use in chat
        </Button>
        <Button variant="outline" size="xs" onClick={props.onStart} disabled={!startable}>
          <BotIcon />
          Start agent
        </Button>
        <Button variant="ghost" size="xs" onClick={props.onOpen} disabled={card.origin_only}>
          <FileTextIcon />
          {card.kind === "note" ? "Read note" : "Open file"}
        </Button>
      </div>
    </article>
  );
}

function TaskGroups(props: {
  cards: ReadonlyArray<TodoBoardCard>;
  view: Exclude<TaskView, "table">;
  renderCard: (card: TodoBoardCard) => ReactNode;
}) {
  const groups = new Map<string, TodoBoardCard[]>();
  for (const card of props.cards) {
    const key =
      props.view === "board"
        ? card.status
        : props.view === "areas"
          ? card.area
          : card.modified === null
            ? "Unknown date"
            : new Date(card.modified * 1000).toLocaleDateString();
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  const entries = [...groups];
  if (props.view === "board")
    entries.sort(([a], [b]) => TASK_STATUS_ORDER.indexOf(a) - TASK_STATUS_ORDER.indexOf(b));
  if (props.view === "timeline")
    entries.sort(
      (a, b) =>
        Math.max(...b[1].map((c) => c.modified ?? 0)) -
        Math.max(...a[1].map((c) => c.modified ?? 0)),
    );
  return (
    <div className="flex flex-wrap items-start gap-4">
      {entries.map(([key, cards]) => (
        <section key={key} className="min-w-[min(17rem,100%)] flex-1 space-y-3">
          <h2 className="flex items-center justify-between gap-2 text-xs font-medium">
            <span>{props.view === "board" ? taskStatusLabel(key) : key}</span>
            <span className="text-muted-foreground">{cards.length}</span>
          </h2>
          {cards.map(props.renderCard)}
        </section>
      ))}
    </div>
  );
}

export function TasksPanel({ project, visible = true, onUseInChat, onExpand }: TasksPanelProps) {
  const configs = useServerConfigs();
  const config = configs.get(project.environmentId);
  const supported = config?.environment.capabilities.todoBoard === true;
  // FORK: cards still waiting for a free slot, from this project's queues.
  const unattended = useEnvironmentQuery(
    config?.environment.capabilities.agentQueue === true
      ? serverEnvironment.unattendedLive({ environmentId: project.environmentId, input: {} })
      : null,
  );
  const queues = (unattended.data?.agentQueues ?? []).filter((queue) =>
    queue.waiting.some((launch) => launch.projectId === project.id),
  );
  const canCancelQueue = useAtomValue(
    serverEnvironment.cancelAgentQueue.permissionAtom(project.environmentId),
  );
  const cancelQueue = useAtomCommand(serverEnvironment.cancelAgentQueue, {
    label: "cancel waiting card agents",
  });
  // Only visible panels poll for updates.
  const query = useEnvironmentQuery(
    supported
      ? projectTodoBoard({ environmentId: project.environmentId, input: { projectId: project.id } })
      : null,
  );
  const baseUrl = useEnvironmentHttpBaseUrl(project.environmentId);
  // Source, view, filters and the cards picked for agents outlive this component, per project.
  const projectKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
  const { filters, view, selected } = useTaskBoard(projectKey);
  const updateBoard = (change: (current: TaskBoardState) => Partial<TaskBoardState>) =>
    useTaskBoardStore.getState().update(projectKey, change);
  const [launch, setLaunch] = useState<ReadonlyArray<TodoBoardCard> | null>(null);
  const [file, setFile] = useState<TaskFile | null>(null);
  const openFile = file?.projectKey === projectKey ? file : null;
  const navigate = useNavigate();
  const refresh = query.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh the server task board only while the panel and document are visible.
  useEffect(() => {
    if (!visible || !supported) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [visible, supported, refresh]);
  const snapshot = query.data?.available ? query.data.snapshot : null;
  const listRef = useRef<HTMLDivElement>(null);
  const listShown = visible && snapshot !== null && openFile === null;
  // The list returns to where it was when it shows again: a card closed, the panel reopened or
  // remounted, another view.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the DOM scroll position when the saved task board view becomes visible.
  useLayoutEffect(() => {
    if (listShown && listRef.current)
      listRef.current.scrollTop = taskBoardScrollTop(projectKey, view);
  }, [listShown, projectKey, view]);
  if (!config)
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner />
        Connecting to environment…
      </div>
    );
  if (!supported)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Tasks are unavailable on this environment.
      </div>
    );
  if (!snapshot)
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        {query.isPending ? (
          <>
            <Spinner />
            Loading tasks…
          </>
        ) : query.error ? (
          <div role="alert" className="flex items-center gap-2">
            <span>{query.error}</span>
            <Button variant="outline" size="xs" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : (
          "This project has no TODO board."
        )}
      </div>
    );
  if (openFile)
    return <TaskFileReader project={project} file={openFile} onClose={() => setFile(null)} />;
  const cards = filteredTasks(snapshot, filters);
  const counts = taskStatusCounts(snapshot, filters.source);
  const setFilter = (field: Exclude<keyof TaskFilters, "source">, value: string) =>
    updateBoard((current) => ({ filters: { ...current.filters, [field]: value } }));
  const setSelected = (change: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
    updateBoard((current) => ({ selected: change(current.selected) }));
  const openCard = (card: TodoBoardCard) => {
    if (!card.origin_only)
      setFile({
        projectKey,
        root: snapshot.root,
        path: card.path,
        note: card.kind === "note" ? card.prompt : null,
      });
  };
  const localEnvironment =
    baseUrl !== null && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
  const toggleCard = (card: TodoBoardCard) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(card.id)) next.add(card.id);
      return next;
    });
  const selectedCards = [...snapshot.cards, ...snapshot.backlog_cards].filter(
    (card) => selected.has(card.id) && canStartTaskAgent(card),
  );
  const startedAgents = (threads: ReadonlyArray<ThreadId>, waiting: number) => {
    setSelected(() => new Set());
    const [first] = threads;
    if (threads.length === 1 && first !== undefined && waiting === 0) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(project.environmentId, first)),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: `Started ${threads.length} ${threads.length === 1 ? "agent" : "agents"}`,
      description:
        waiting === 0
          ? "Their threads are in the sidebar."
          : `${waiting} more start as these finish. Their threads are in the sidebar.`,
    });
  };
  const renderCard = (card: TodoBoardCard) => (
    <TaskCard
      key={card.id}
      card={card}
      selected={selected.has(card.id)}
      onToggle={() => toggleCard(card)}
      onUse={() => onUseInChat(card)}
      onOpen={() => openCard(card)}
      onStart={() => setLaunch([card])}
    />
  );
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-3 border-b p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-medium">Tasks</h1>
          <span className="text-xs text-muted-foreground">{project.title}</span>
          <div className="ml-auto flex items-center gap-1">
            {localEnvironment && snapshot.url ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  void readLocalApi()?.shell.openExternal(snapshot.url);
                }}
              >
                <ExternalLinkIcon />
                External board
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh tasks"
              disabled={query.isPending}
              onClick={refresh}
            >
              {query.isPending ? <Spinner /> : <RefreshCwIcon />}
            </Button>
            {onExpand ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Expand Tasks to full workspace"
                onClick={onExpand}
              >
                <ExpandIcon />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 empty:hidden">
          {(["ready", "in_progress", "blocked"] as const)
            .filter((status) => counts[status] > 0 || filters.status === status)
            .map((status) => (
              <Button
                key={status}
                variant="outline"
                size="sm"
                aria-pressed={filters.status === status}
                onClick={() => setFilter("status", filters.status === status ? "" : status)}
              >
                <span className="tabular-nums">{counts[status]}</span>
                {taskStatusLabel(status)}
              </Button>
            ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="Task source" className="flex gap-1">
            {(["todo", "backlog", "all"] as const).map((source) => (
              <Button
                key={source}
                size="xs"
                variant={filters.source === source ? "secondary" : "ghost"}
                aria-pressed={filters.source === source}
                onClick={() =>
                  updateBoard((current) => ({
                    filters: withTaskSource(snapshot, current.filters, source),
                  }))
                }
              >
                {source === "todo" ? "TODO" : source === "backlog" ? "Backlog" : "All"}
              </Button>
            ))}
          </div>
          <div role="group" aria-label="Task view" className="flex flex-wrap gap-1">
            {(["board", "areas", "table", "timeline"] as const).map((next) => (
              <Button
                key={next}
                size="xs"
                variant={view === next ? "secondary" : "ghost"}
                aria-pressed={view === next}
                onClick={() => updateBoard(() => ({ view: next }))}
              >
                {next.slice(0, 1).toUpperCase() + next.slice(1)}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-36 flex-1">
            <Input
              size="sm"
              type="search"
              value={filters.search}
              onChange={(event) => setFilter("search", event.target.value)}
              aria-label="Search tasks"
              placeholder="Search tasks…"
            />
          </div>
          <TaskFilter
            label="Task status"
            value={filters.status}
            options={[
              { value: "", label: "All statuses" },
              ...["ready", "in_progress", "blocked", "backlog"].map((value) => ({
                value,
                label: taskStatusLabel(value),
              })),
            ]}
            onChange={(value) => setFilter("status", value)}
          />
          <TaskFilter
            label="Priority"
            value={filters.priority}
            options={[
              { value: "", label: "All priorities" },
              ...["P0", "P1", "P2", "P3"].map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => setFilter("priority", value)}
          />
          <TaskFilter
            label="Task area"
            value={filters.area}
            options={[
              { value: "", label: "All areas" },
              ...taskAreas(snapshot, filters.source).map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => setFilter("area", value)}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {countLabel(cards.length, "task")}
            {filters.source === "backlog"
              ? ` · ${countLabel(snapshot.counts.backlog, "card")} · ${countLabel(snapshot.counts.backlog_notes, "older note")}`
              : ""}
          </span>
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} />}>
              Updated{" "}
              {new Date(snapshot.generated_ts * 1000).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </TooltipTrigger>
            <TooltipPopup>{snapshot.generated_at}</TooltipPopup>
          </Tooltip>
        </div>
        {query.error ? (
          <div role="alert" className="text-sm text-warning-foreground">
            Refresh failed. Showing the previous snapshot.
          </div>
        ) : null}
        {queues.map((queue) => (
          <div
            key={queue.id}
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          >
            <span className="tabular-nums">
              {queue.label}: {queue.waiting.length} waiting, {queue.maxRunning} at a time
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={!canCancelQueue}
              onClick={() =>
                void cancelQueue({
                  environmentId: project.environmentId,
                  input: { id: queue.id },
                }).then((result) => {
                  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                    const error = squashAtomCommandFailure(result);
                    toastManager.add({
                      type: "error",
                      title: "Could not cancel the waiting agents",
                      description: error instanceof Error ? error.message : String(error),
                    });
                  }
                })
              }
            >
              Cancel the rest
            </Button>
          </div>
        ))}
        {selectedCards.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="tabular-nums">{selectedCards.length} selected</span>
            <Button size="xs" onClick={() => setLaunch(selectedCards)}>
              <BotIcon />
              Start agents…
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setSelected(() => new Set())}>
              Clear
            </Button>
          </div>
        ) : null}
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto p-4"
        onScroll={(event) =>
          useTaskBoardStore.getState().setScrollTop(projectKey, view, event.currentTarget.scrollTop)
        }
      >
        {cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matching tasks.</p>
        ) : view === "table" ? (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="w-8 p-2">
                  <span className="sr-only">Select</span>
                </th>
                <th className="p-2">Task</th>
                <th className="p-2">Status</th>
                <th className="p-2 @max-2xl:hidden">Priority</th>
                <th className="p-2 @max-2xl:hidden">Area</th>
                <th className="p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card.id} className="border-b">
                  <td className="p-2 align-top">
                    <Checkbox
                      checked={selected.has(card.id)}
                      disabled={!canStartTaskAgent(card)}
                      onCheckedChange={() => toggleCard(card)}
                      aria-label={`Select ${card.id}`}
                    />
                  </td>
                  <td className="p-2 @2xl:min-w-44">
                    <div className="break-all font-mono text-muted-foreground">{card.id}</div>
                    <button
                      type="button"
                      onClick={() => openCard(card)}
                      disabled={card.origin_only}
                      className="text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {card.title}
                    </button>
                    <div className="text-muted-foreground @2xl:hidden">
                      {[card.pri, card.area].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  <td className="p-2">
                    {taskStatusLabel(card.status)}
                    {card.stale ? <div className="text-warning-foreground">Stale claim</div> : null}
                    {card.origin_only ? (
                      <div className="text-warning-foreground">Origin only</div>
                    ) : null}
                    {card.origin_status ? (
                      <div className="text-warning-foreground">
                        Origin: {taskStatusLabel(card.origin_status)}
                      </div>
                    ) : null}
                  </td>
                  <td className="p-2 @max-2xl:hidden">{card.pri ?? "–"}</td>
                  <td className="p-2 @max-2xl:hidden">{card.area}</td>
                  <td className="p-2">
                    <div className="flex flex-wrap gap-1">
                      <TaskAction
                        label="Use in chat"
                        icon={<MessageSquareIcon />}
                        onClick={() => onUseInChat(card)}
                      />
                      <TaskAction
                        label="Start agent"
                        icon={<BotIcon />}
                        onClick={() => setLaunch([card])}
                        disabled={!canStartTaskAgent(card)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <TaskGroups cards={cards} view={view} renderCard={renderCard} />
        )}
      </div>
      {launch !== null ? (
        <TaskAgentsDialog
          project={project}
          root={snapshot.root}
          cards={launch}
          onClose={() => setLaunch(null)}
          onStarted={startedAgents}
        />
      ) : null}
    </div>
  );
}

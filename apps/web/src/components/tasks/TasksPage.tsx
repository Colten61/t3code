import {
  scopeProjectRef,
  scopedProjectKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, TodoBoardCard } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ListTodoIcon } from "lucide-react";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { useProjects, useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { TasksPanel } from "./TasksPanel";
import { appendTaskPrompt } from "./taskBoardLogic";
import { newDraftId } from "~/lib/utils";

export interface TasksPageSearch {
  environmentId?: EnvironmentId;
  projectId?: ProjectId;
  threadId?: ThreadId;
  draftId?: string;
}

export function TasksPage({ search }: { search: TasksPageSearch }) {
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const project =
    search.projectId || search.environmentId
      ? (projects.find(
          (candidate) =>
            candidate.id === search.projectId && candidate.environmentId === search.environmentId,
        ) ?? null)
      : (projects[0] ?? null);
  const projectRef = project ? scopeProjectRef(project.environmentId, project.id) : null;
  const projectKey = projectRef ? scopedProjectKey(projectRef) : null;
  const stageCard = (card: TodoBoardCard) => {
    if (!project || !projectRef) return;
    const store = useComposerDraftStore.getState();
    const thread = threads.find(
      (candidate) =>
        candidate.environmentId === project.environmentId &&
        candidate.id === search.threadId &&
        candidate.projectId === project.id,
    );
    if (thread) {
      const ref = scopeThreadRef(project.environmentId, ThreadId.make(thread.id));
      store.setPrompt(ref, appendTaskPrompt(store.getComposerDraft(ref)?.prompt ?? "", card));
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      return;
    }
    const targeted = search.draftId ? store.getDraftSession(DraftId.make(search.draftId)) : null;
    const matchingTarget =
      targeted?.projectId === project.id && targeted.environmentId === project.environmentId
        ? targeted
        : null;
    const existing = matchingTarget
      ? { draftId: DraftId.make(search.draftId ?? "") }
      : store.getDraftSessionByProjectRef(projectRef);
    const draftId = existing?.draftId ?? newDraftId();
    if (!existing)
      store.setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
        envMode: "local",
        environmentSelection: "manual",
      });
    store.setPrompt(draftId, appendTaskPrompt(store.getComposerDraft(draftId)?.prompt ?? "", card));
    void navigate({ to: "/draft/$draftId", params: { draftId } });
  };
  return (
    <main className="flex h-full min-h-0 flex-col">
      <WorkspacePageHeader electron={isElectron}>
        <ListTodoIcon className="size-4" />
        <h1 className="text-sm font-medium">Tasks</h1>
        <div className="ml-auto min-w-0">
          <Select
            value={projectKey}
            items={projects.map((item) => ({
              value: scopedProjectKey(scopeProjectRef(item.environmentId, item.id)),
              label: item.title,
            }))}
            onValueChange={(value) => {
              const next = projects.find(
                (item) => scopedProjectKey(scopeProjectRef(item.environmentId, item.id)) === value,
              );
              if (next)
                void navigate({
                  to: "/tasks",
                  search: { environmentId: next.environmentId, projectId: next.id },
                });
            }}
          >
            <SelectTrigger size="sm" aria-label="Tasks project">
              <SelectValue placeholder="Choose project" />
            </SelectTrigger>
            <SelectPopup>
              {projects.map((item) => (
                <SelectItem
                  key={`${item.environmentId}:${item.id}`}
                  value={scopedProjectKey(scopeProjectRef(item.environmentId, item.id))}
                >
                  {item.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </WorkspacePageHeader>
      {!project ? (
        <p className="p-6 text-sm text-muted-foreground">
          {projects.length === 0 ? "No projects." : "Project unavailable."}
        </p>
      ) : (
        <div className="min-h-0 flex-1">
          <TasksPanel key={projectKey} project={project} onUseInChat={stageCard} />
        </div>
      )}
    </main>
  );
}

// FORK: what the Tasks board shows for each project (by scoped project key), kept for the session so
// it outlives the board: another panel tab, the full-screen page and a trip to the chat remount it.
import { create } from "zustand";

import type { TaskFilters, TaskView } from "./taskBoardLogic";

export interface TaskBoardState {
  readonly filters: TaskFilters;
  readonly view: TaskView;
  /** Cards ticked for agents, by id; Night starts with them ticked too. */
  readonly selected: ReadonlySet<string>;
}

const DEFAULT_TASK_BOARD: TaskBoardState = {
  filters: { source: "todo", search: "", status: "", priority: "", area: "" },
  view: "board",
  selected: new Set(),
};

interface TaskBoardStoreState {
  readonly boards: Readonly<Record<string, TaskBoardState>>;
  /** List offsets by project and view, apart from `boards` so scrolling re-renders no board. */
  readonly scrollTops: Readonly<Record<string, number>>;
  readonly update: (
    projectKey: string,
    change: (current: TaskBoardState) => Partial<TaskBoardState>,
  ) => void;
  readonly setScrollTop: (projectKey: string, view: TaskView, top: number) => void;
}

const scrollKey = (projectKey: string, view: TaskView) => `${projectKey}\n${view}`;

export const useTaskBoardStore = create<TaskBoardStoreState>()((set) => ({
  boards: {},
  scrollTops: {},
  update: (projectKey, change) =>
    set((state) => {
      const current = state.boards[projectKey] ?? DEFAULT_TASK_BOARD;
      return { boards: { ...state.boards, [projectKey]: { ...current, ...change(current) } } };
    }),
  setScrollTop: (projectKey, view, top) =>
    set((state) =>
      state.scrollTops[scrollKey(projectKey, view)] === top
        ? state
        : { scrollTops: { ...state.scrollTops, [scrollKey(projectKey, view)]: top } },
    ),
}));

export const taskBoardState = (projectKey: string) =>
  useTaskBoardStore.getState().boards[projectKey] ?? DEFAULT_TASK_BOARD;

export const useTaskBoard = (projectKey: string) =>
  useTaskBoardStore((state) => state.boards[projectKey] ?? DEFAULT_TASK_BOARD);

export const taskBoardScrollTop = (projectKey: string, view: TaskView) =>
  useTaskBoardStore.getState().scrollTops[scrollKey(projectKey, view)] ?? 0;

import { describe, expect, it } from "vite-plus/test";

import { taskBoardScrollTop, taskBoardState, useTaskBoardStore } from "./taskBoardStore";

describe("task board store", () => {
  it("keeps each project's source, view, filters and ticked cards apart", () => {
    const { update } = useTaskBoardStore.getState();
    update("local:alpha", (current) => ({
      view: "table",
      filters: { ...current.filters, source: "backlog", search: "parked", area: "core" },
      selected: new Set(["TASK-001"]),
    }));
    expect(taskBoardState("local:alpha")).toMatchObject({
      view: "table",
      filters: { source: "backlog", search: "parked", area: "core" },
    });
    expect([...taskBoardState("local:alpha").selected]).toEqual(["TASK-001"]);
    expect(taskBoardState("remote:alpha")).toMatchObject({ view: "board", selected: new Set() });
    expect(taskBoardState("remote:alpha").filters.source).toBe("todo");
  });

  it("remembers the scroll offset per project and view without touching the boards", () => {
    const boards = useTaskBoardStore.getState().boards;
    useTaskBoardStore.getState().setScrollTop("local:beta", "table", 350);
    expect(taskBoardScrollTop("local:beta", "table")).toBe(350);
    expect(taskBoardScrollTop("local:beta", "board")).toBe(0);
    expect(taskBoardScrollTop("local:gamma", "table")).toBe(0);
    expect(useTaskBoardStore.getState().boards).toBe(boards);
  });
});

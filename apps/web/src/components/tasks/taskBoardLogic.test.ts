import type { TodoBoardCard, TodoBoardSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  appendTaskPrompt,
  countLabel,
  filteredTasks,
  inBoardOrder,
  markdownPlainText,
  taskAreas,
  taskExcerpt,
  taskPrompt,
  taskStatusCounts,
  withTaskSource,
  type TaskFilters,
} from "./taskBoardLogic";

const card = (overrides: Partial<TodoBoardCard> = {}): TodoBoardCard => ({
  id: "TASK-001",
  kind: "card",
  title: "Task",
  brief: "Outcome",
  prompt: `/take-card ${overrides.id ?? "TASK-001"}`,
  path: `docs/todo/${overrides.id ?? "TASK-001"}.md`,
  status: "ready",
  pri: "P1",
  size: "S",
  area: "core",
  pack: "",
  source: "todo",
  ord: 0,
  created: null,
  modified: null,
  stale: false,
  origin_only: false,
  origin_status: null,
  branch: null,
  ...overrides,
});
const todo = card({
  id: "ACTIVE-001",
  status: "in_progress",
  stale: true,
  origin_status: "closed",
  branch: { branch: "task/active-001", dirty: 3, ahead: 1, behind: 2, tip_status: "in_progress" },
});
const parked = card({
  id: "PARKED-001",
  source: "backlog",
  status: "backlog",
  pri: null,
  size: null,
});
const note = card({
  id: "NOTE-001",
  kind: "note",
  source: "backlog",
  status: "backlog",
  prompt: "Full original note\n\nKeep its boundaries.",
  path: "BACKLOG.md",
  pri: null,
  size: null,
});
const data: TodoBoardSnapshot = {
  root: "/project",
  url: "",
  generated_at: "2026-10-07 06:00 UTC",
  generated_ts: 0,
  cards: [todo, card()],
  backlog_cards: [parked, note],
  area_order: ["core"],
  counts: { total: 2, ready: 1, in_progress: 1, blocked: 0, backlog: 1, backlog_notes: 1 },
};
const filters: TaskFilters = { source: "todo", search: "", status: "", priority: "", area: "" };

describe("native task board", () => {
  it("keeps TODO, parked cards and original notes separate without promoting backlog", () => {
    expect(filteredTasks(data, filters).map((c) => c.id)).toEqual(["ACTIVE-001", "TASK-001"]);
    expect(filteredTasks(data, { ...filters, source: "backlog" }).map((c) => c.id)).toEqual([
      "NOTE-001",
      "PARKED-001",
    ]);
    expect(filteredTasks(data, { ...filters, source: "all" })).toHaveLength(4);
    expect(parked.status).toBe("backlog");
  });
  it("preserves a local claim and origin discrepancy while filtering on local status and branch", () => {
    const result = filteredTasks(data, {
      ...filters,
      status: "in_progress",
      search: "task/active-001",
    });
    expect(result).toEqual([todo]);
    expect(result[0]?.stale).toBe(true);
    expect(result[0]?.origin_status).toBe("closed");
    expect(filteredTasks(data, { ...filters, status: "closed" })).toEqual([]);
  });
  it("handles missing estimates and unknown priority without changing missing data to zero", () => {
    const unknown = card({ id: "UNKNOWN-001", pri: "?" });
    const sorted = filteredTasks({ ...data, cards: [unknown, ...data.cards] }, filters);
    expect(sorted.at(-1)).toEqual(unknown);
    expect(parked.size).toBeNull();
  });
  it("keeps P0 questions ahead of ready work instead of treating zero as missing priority", () => {
    const question = card({ id: "QUESTION-001", pri: "P0", status: "blocked" });
    expect(filteredTasks({ ...data, cards: [...data.cards, question] }, filters)[0]).toBe(question);
    expect(
      filteredTasks({ ...data, cards: [...data.cards, question] }, { ...filters, priority: "P0" }),
    ).toEqual([question]);
  });
  it("stages original notes without making a take-card command", () => {
    expect(taskPrompt(note)).toBe(note.prompt);
    expect(taskPrompt(note)).not.toContain("/take-card");
  });
  it("appends a card without overwriting an existing draft or duplicating repeated staging", () => {
    const draft = "My unfinished request\nwith its context";
    const staged = appendTaskPrompt(draft, todo);
    expect(staged).toBe(`${draft}\n\n/take-card ACTIVE-001\n\nOutcome`);
    expect(appendTaskPrompt(staged, todo)).toBe(staged);
    expect(appendTaskPrompt("", note)).toBe(note.prompt);
  });
});

describe("task board per source", () => {
  const roadmap = card({
    id: "LATER-001",
    source: "backlog",
    status: "backlog",
    area: "R4 — closed loop",
  });
  const unlisted = card({ id: "CRAWL-001", area: "Crawl" });
  const board: TodoBoardSnapshot = {
    ...data,
    cards: [...data.cards, unlisted],
    backlog_cards: [...data.backlog_cards, roadmap],
    area_order: ["R4 — closed loop", "core"],
  };

  it("offers only the areas the source has, listed ones first", () => {
    expect(taskAreas(board, "todo")).toEqual(["core", "Crawl"]);
    expect(taskAreas(board, "backlog")).toEqual(["R4 — closed loop", "core"]);
    expect(taskAreas(board, "all")).toEqual(["R4 — closed loop", "core", "Crawl"]);
  });

  it("drops an area the new source lacks and keeps one it has", () => {
    const backlogArea = { ...filters, source: "backlog" as const, area: "R4 — closed loop" };
    expect(withTaskSource(board, backlogArea, "todo")).toEqual({ ...filters, area: "" });
    expect(withTaskSource(board, { ...filters, status: "ready", area: "core" }, "all")).toEqual({
      ...filters,
      source: "all",
      area: "core",
    });
  });

  it("counts statuses in the shown source, not TODO's", () => {
    expect(taskStatusCounts(board, "todo")).toEqual({ ready: 2, in_progress: 1, blocked: 0 });
    expect(taskStatusCounts(board, "backlog")).toEqual({ ready: 0, in_progress: 0, blocked: 0 });
  });

  it("pluralizes counts", () => {
    expect(countLabel(1, "task")).toBe("1 task");
    expect(countLabel(0, "task")).toBe("0 tasks");
    expect(countLabel(2, "older note")).toBe("2 older notes");
  });

  it("orders cards like the Board view: Ready, In progress, Blocked, then by priority", () => {
    const question = card({ id: "QUESTION-001", pri: "P0", status: "blocked" });
    const urgent = card({ id: "READY-P0", pri: "P0" });
    const minor = card({ id: "READY-P3", pri: "P3" });
    expect(inBoardOrder([question, parked, minor, todo, urgent]).map((c) => c.id)).toEqual([
      "READY-P0",
      "READY-P3",
      "ACTIVE-001",
      "QUESTION-001",
      "PARKED-001",
    ]);
  });
});

describe("card excerpt", () => {
  it("reads Markdown as the words it shows", () => {
    expect(
      markdownPlainText(
        "### Outcome Base: [MET-WORKER-001](MET-WORKER-001.md) at `5fc52ce` and **only** `home_plan` ships; _see_ ![chart](a.png)",
      ),
    ).toBe("Outcome Base: MET-WORKER-001 at 5fc52ce and only home_plan ships; see chart");
  });

  it("keeps identifiers and code intact while dropping a backtick cut from its pair", () => {
    expect(markdownPlainText("Base: main`; airbag (`CURRENT_STATE.md`, the row)")).toBe(
      "Base: main; airbag (CURRENT_STATE.md, the row)",
    );
    expect(markdownPlainText("run `a **b** c` in C# for CURRENT_STATE_FILE")).toBe(
      "run a **b** c in C# for CURRENT_STATE_FILE",
    );
  });

  it("drops the copy of the title the brief starts with", () => {
    const titled = card({
      title: "pull the worker images by digest",
      brief: "pull the worker images by digest. Base: `main` after [CLOUD-001](CLOUD-001.md)",
    });
    expect(taskExcerpt(titled)).toBe("Base: main after CLOUD-001");
    expect(taskExcerpt(card({ title: "Ship it.", brief: "Ship it." }))).toBe("");
    expect(taskExcerpt(card({ title: "Ship", brief: "Shipping starts Monday" }))).toBe(
      "Shipping starts Monday",
    );
  });
});

import { EnvironmentId, ProjectId, type TodoBoardSnapshot } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { TasksPage } from "./TasksPage";
import { useTaskBoardStore } from "./taskBoardStore";

const project = {
  id: ProjectId.make("board"),
  environmentId: EnvironmentId.make("local"),
  title: "AIHub",
  workspaceRoot: "/integration",
};
const snapshot: TodoBoardSnapshot = {
  root: "/integration",
  url: "",
  generated_at: "2026-10-07 06:00 UTC",
  generated_ts: 0,
  cards: [],
  backlog_cards: [
    {
      id: "PARKED-001",
      kind: "card",
      title: "Parked task",
      brief: "Keep this parked",
      prompt: "/take-card PARKED-001",
      path: "docs/todo/PARKED-001.md",
      status: "backlog",
      pri: "P2",
      size: "S",
      area: "core",
      pack: "",
      source: "backlog",
      ord: 0,
      created: null,
      modified: null,
      stale: false,
      origin_only: false,
      origin_status: null,
      branch: null,
    },
  ],
  area_order: ["core"],
  counts: { total: 0, ready: 0, in_progress: 0, blocked: 0, backlog: 1, backlog_notes: 0 },
};
const refresh = vi.fn();
vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/state/entities", () => ({
  useProjects: () => [project],
  useThreadShells: () => [],
  useServerConfigs: () =>
    new Map([[project.environmentId, { environment: { capabilities: { todoBoard: true } } }]]),
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("~/state/projects", () => ({
  projectTodoBoard: () => ({ kind: "board" }),
  projectEnvironment: { readFile: () => ({ kind: "file" }) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data:
      atom?.kind === "board"
        ? { available: true, snapshot }
        : atom?.kind === "file"
          ? { contents: "Card source", truncated: false }
          : null,
    isPending: false,
    error: null,
    refresh,
  }),
}));
vi.mock("~/components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("~/components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

async function click(within: Element, label: string) {
  const button = [...within.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

/**
 * An empty board store, and a list that scrolls in every board that mounts: tests load no
 * stylesheet.
 */
function freshBoard(): Disposable {
  useTaskBoardStore.setState({ boards: {}, scrollTops: {} });
  const style = document.createElement("style");
  style.textContent = "div:has(> table) { height: 1px; overflow: auto; }";
  document.head.append(style);
  return { [Symbol.dispose]: () => style.remove() };
}

const tasksPage = (
  <TasksPage search={{ environmentId: project.environmentId, projectId: project.id }} />
);

/** Backlog, Table, a search and a scrolled list; returns the offset. */
async function arrangeBoard(host: HTMLElement) {
  await click(host.querySelector('[aria-label="Task source"]')!, "Backlog");
  await click(host.querySelector('[aria-label="Task view"]')!, "Table");
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Parked",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const scroll = host.querySelector("table")!.parentElement!;
  const scrolledTo = scroll.scrollHeight - scroll.clientHeight;
  expect(scrolledTo).toBeGreaterThan(0);
  await act(async () => {
    scroll.scrollTop = scrolledTo;
    scroll.dispatchEvent(new Event("scroll"));
  });
  return scrolledTo;
}

function expectArranged(host: HTMLElement, scrolledTo: number) {
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')?.value).toBe(
    "Parked",
  );
  expect(
    host.querySelector('[aria-label="Task source"] button[aria-pressed="true"]')?.textContent,
  ).toBe("Backlog");
  expect(
    host.querySelector('[aria-label="Task view"] button[aria-pressed="true"]')?.textContent,
  ).toBe("Table");
  expect(host.querySelector("table")?.parentElement?.scrollTop).toBe(scrolledTo);
}

it("returns to Backlog, Table, search and scroll after reading a card", async () => {
  using _board = freshBoard();
  await using screen = await render(tasksPage);
  const host = screen.container;
  const scrolledTo = await arrangeBoard(host);
  await click(host, "Parked task");
  expect(host.querySelector("pre")?.textContent).toBe("Card source");
  expect(host.querySelector("table")).toBeNull();
  await click(host, "Tasks");
  expectArranged(host, scrolledTo);
});

it("keeps the board as it was when it mounts again (another tab, the full page, the chat)", async () => {
  using _board = freshBoard();
  await using screen = await render(tasksPage);
  const host = screen.container;
  const scrolledTo = await arrangeBoard(host);
  await screen.rerender(<div />);
  expect(host.querySelector("table")).toBeNull();
  await screen.rerender(tasksPage);
  expectArranged(host, scrolledTo);
});

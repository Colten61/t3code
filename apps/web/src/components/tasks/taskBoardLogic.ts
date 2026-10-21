import type { TodoBoardCard, TodoBoardSnapshot } from "@t3tools/contracts";

export type TaskSource = "todo" | "backlog" | "all";
export type TaskView = "board" | "areas" | "table" | "timeline";
export interface TaskFilters {
  source: TaskSource;
  search: string;
  status: string;
  priority: string;
  area: string;
}

/** The Board view's columns, in order; any other status follows them. */
export const TASK_STATUS_ORDER: ReadonlyArray<string> = [
  "ready",
  "in_progress",
  "blocked",
  "backlog",
];

const priorityRank = (priority: string | null) => Number(priority?.match(/^P(\d+)$/)?.[1] ?? 9);
const statusRank = (status: string) =>
  TASK_STATUS_ORDER.includes(status) ? TASK_STATUS_ORDER.indexOf(status) : TASK_STATUS_ORDER.length;
const byPriority = (a: TodoBoardCard, b: TodoBoardCard) =>
  priorityRank(a.pri) - priorityRank(b.pri) || a.ord - b.ord || a.id.localeCompare(b.id);

function sourceCards(snapshot: TodoBoardSnapshot, source: TaskSource) {
  return source === "todo"
    ? snapshot.cards
    : source === "backlog"
      ? snapshot.backlog_cards
      : [...snapshot.cards, ...snapshot.backlog_cards];
}

export function filteredTasks(snapshot: TodoBoardSnapshot, filters: TaskFilters) {
  const query = filters.search.trim().toLocaleLowerCase();
  return sourceCards(snapshot, filters.source)
    .filter(
      (card) =>
        (!filters.status || card.status === filters.status) &&
        (!filters.priority || card.pri === filters.priority) &&
        (!filters.area || card.area === filters.area) &&
        (!query ||
          [card.id, card.title, card.brief, card.area, card.pack, card.branch?.branch]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query)),
    )
    .toSorted(byPriority);
}

/** Cards the way the Board view shows them: Ready, In progress, Blocked, Backlog, each by priority. */
export function inBoardOrder(cards: ReadonlyArray<TodoBoardCard>) {
  return cards.toSorted((a, b) => statusRank(a.status) - statusRank(b.status) || byPriority(a, b));
}

/** The areas the source's cards are in: the board's order first, then any it does not list. */
export function taskAreas(snapshot: TodoBoardSnapshot, source: TaskSource): ReadonlyArray<string> {
  const present = new Set(sourceCards(snapshot, source).map((card) => card.area));
  return [
    ...snapshot.area_order.filter((area) => present.has(area)),
    ...[...present].filter((area) => !snapshot.area_order.includes(area)),
  ];
}

/** Switching the source clears the status filter and drops an area the new source does not have. */
export function withTaskSource(
  snapshot: TodoBoardSnapshot,
  filters: TaskFilters,
  source: TaskSource,
): TaskFilters {
  const area = taskAreas(snapshot, source).includes(filters.area) ? filters.area : "";
  return { ...filters, source, status: "", area };
}

export function taskStatusCounts(snapshot: TodoBoardSnapshot, source: TaskSource) {
  const counts: Record<"ready" | "in_progress" | "blocked", number> = {
    ready: 0,
    in_progress: 0,
    blocked: 0,
  };
  for (const { status } of sourceCards(snapshot, source)) {
    if (status === "ready" || status === "in_progress" || status === "blocked") counts[status] += 1;
  }
  return counts;
}

/** "1 task", "2 tasks". */
export const countLabel = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const plainProse = (text: string) =>
  text
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)>\s+/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|\W)_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2")
    // A backtick left without its pair, where a code span was cut.
    .replace(/`/g, "");

/** What a line of Markdown reads as: links, code, emphasis and headings become their text. */
export function markdownPlainText(markdown: string) {
  // Links go before code spans, so a link whose text is code keeps only that text.
  const linked = markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, "$1");
  let text = "";
  let from = 0;
  for (const span of linked.matchAll(/(`+)(.+?)\1(?!`)/g)) {
    text += plainProse(linked.slice(from, span.index)) + (span[2] ?? "");
    from = span.index + span[0].length;
  }
  return (text + plainProse(linked.slice(from))).replace(/\s+/g, " ").trim();
}

/** A card's excerpt as plain text, without the copy of the title its brief starts with. */
export function taskExcerpt(card: TodoBoardCard) {
  const title = card.title.trim().replace(/\.+$/, "");
  const brief = card.brief.trim();
  const rest = title && brief.startsWith(title) ? brief.slice(title.length) : null;
  return markdownPlainText(
    rest !== null && /^(?:\.|\s|$)/.test(rest) ? rest.replace(/^\./, "") : brief,
  );
}

export function taskPrompt(card: TodoBoardCard) {
  return card.kind === "note"
    ? card.prompt
    : `${card.prompt || `/take-card ${card.id}`}\n\n${card.brief || card.title}`;
}

export function appendTaskPrompt(existing: string, card: TodoBoardCard) {
  const prompt = taskPrompt(card);
  return existing.endsWith(prompt)
    ? existing
    : existing.length > 0
      ? `${existing}\n\n${prompt}`
      : prompt;
}

export function taskStatusLabel(status: string) {
  return (
    {
      ready: "Ready",
      in_progress: "In progress",
      blocked: "Blocked",
      backlog: "Backlog",
      closed: "Closed",
    }[status] ?? status
  );
}

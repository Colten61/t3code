import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";

import type {
  BackgroundWorkEntry,
  FinishedBackgroundWorkEntry,
} from "./BackgroundWorkDrawer.logic";

vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { backgroundTaskOutput: () => null },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, refresh: () => undefined }),
}));
// Plain stand-ins for the banner primitives (the scroll area needs real DOM);
// they keep props and refs, so a row's title line can be observed.
vi.mock("./ComposerBanner", async () => {
  const { cloneElement } = await import("react");
  const part = ({
    children,
    render,
    ...props
  }: {
    readonly children?: ReactNode;
    readonly render?: ReactElement;
  }) => cloneElement(render ?? <div />, props, children);
  return {
    ComposerBanner: {
      Scroll: part,
      Children: part,
      Row: part,
      Icon: part,
      Content: part,
      Actions: part,
    },
  };
});

const { BackgroundWorkDrawer } = await import("./BackgroundWorkDrawer");

interface FakeObserver {
  readonly callback: (
    entries: ReadonlyArray<{ isIntersecting: boolean; intersectionRatio: number }>,
  ) => void;
  readonly nodes: Array<HTMLElement>;
  disconnected: boolean;
}

const observers: Array<FakeObserver> = [];
const taskIdOf = (node: HTMLElement) => node.dataset.backgroundWorkTitle;

class FakeIntersectionObserver {
  private readonly record: FakeObserver;
  constructor(callback: FakeObserver["callback"]) {
    this.record = { callback, nodes: [], disconnected: false };
    observers.push(this.record);
  }
  observe(node: HTMLElement) {
    this.record.nodes.push(node);
  }
  disconnect() {
    this.record.disconnected = true;
  }
}

function liveObservers(): ReadonlyArray<FakeObserver> {
  return observers.filter((observer) => !observer.disconnected);
}

/** Reports how much of a row's title line is in view. */
async function intersect(taskId: string, ratio: number) {
  const observer = liveObservers().find((candidate) =>
    candidate.nodes.some((node) => taskIdOf(node) === taskId),
  );
  expect(observer, `an observer for ${taskId}`).toBeDefined();
  await act(() => observer?.callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]));
}

/** Hides a row's title line the way another notice covering it would: it stays laid out. */
function setShown(taskId: string, shown: boolean) {
  const title = document.querySelector<HTMLElement>(`[data-background-work-title="${taskId}"]`);
  expect(title, `the title line of ${taskId}`).not.toBeNull();
  title!.style.opacity = shown ? "" : "0";
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

function finishedEntry(taskId: string, read = false): FinishedBackgroundWorkEntry {
  return {
    taskId,
    kind: "command",
    label: `npm test ${taskId}`,
    childThreadId: undefined,
    kindLabel: "Command",
    command: undefined,
    startedAt: undefined,
    hasOutput: true,
    finishedAt: "2026-10-09T10:00:00.000Z",
    read,
  };
}

const running: ReadonlyArray<BackgroundWorkEntry> = [
  {
    taskId: "brun00001",
    kind: "command",
    label: "npm run dev",
    childThreadId: undefined,
    kindLabel: "Command",
    command: undefined,
    startedAt: undefined,
    hasOutput: true,
  },
];

function drawer(input: {
  readonly threadId?: string;
  readonly running?: ReadonlyArray<BackgroundWorkEntry>;
  readonly finished: ReadonlyArray<FinishedBackgroundWorkEntry>;
  readonly onRead: (taskId: string) => void;
}) {
  return (
    <BackgroundWorkDrawer
      environmentId={"env" as EnvironmentId}
      threadId={ThreadId.make(input.threadId ?? "thread-1")}
      running={input.running ?? []}
      finished={input.finished}
      onOpenThread={() => undefined}
      onRead={input.onRead}
    />
  );
}

// Each test fakes the timers and the observer, then renders: disposal runs in reverse, so the
// drawer unmounts before either is restored.
function setup(): Disposable {
  observers.length = 0;
  const timers = fakeTimers();
  const observer = stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  return {
    [Symbol.dispose]() {
      observer[Symbol.dispose]();
      timers[Symbol.dispose]();
    },
  };
}

describe("BackgroundWorkDrawer read marking", () => {
  it("does not mark finished rows read just because the drawer mounted", async () => {
    using _fakes = setup();
    const onRead = vi.fn();
    await using _screen = await render(drawer({ finished: [finishedEntry("bdone0001")], onRead }));
    await advance(5_000);
    expect(onRead).not.toHaveBeenCalled();
  });

  it("does not mark a row read while it is hidden behind another notice", async () => {
    using _fakes = setup();
    const onRead = vi.fn();
    await using _screen = await render(drawer({ finished: [finishedEntry("bdone0001")], onRead }));
    setShown("bdone0001", false);
    await intersect("bdone0001", 1);
    await advance(5_000);
    expect(onRead).not.toHaveBeenCalled();
    setShown("bdone0001", true);
    await advance(700);
    expect(onRead).toHaveBeenCalledExactlyOnceWith("bdone0001");
  });

  it("marks a row read once it has been on screen", async () => {
    using _fakes = setup();
    const onRead = vi.fn();
    await using _screen = await render(drawer({ finished: [finishedEntry("bdone0001")], onRead }));
    await intersect("bdone0001", 1);
    await advance(700);
    expect(onRead).toHaveBeenCalledExactlyOnceWith("bdone0001");
  });

  it("marks only the finished rows that were on screen themselves", async () => {
    using _fakes = setup();
    const onRead = vi.fn();
    await using _screen = await render(
      drawer({
        running,
        finished: [
          finishedEntry("bdone0001"),
          finishedEntry("bdone0002"),
          finishedEntry("bold0001", true),
        ],
        onRead,
      }),
    );
    // Running rows and rows already read are not watched at all.
    const watched = liveObservers().flatMap((observer) => observer.nodes.map(taskIdOf));
    expect(watched.toSorted()).toEqual(["bdone0001", "bdone0002"]);
    // The first finished row is in view; the second is clipped by the scroll area.
    await intersect("bdone0001", 1);
    await intersect("bdone0002", 0);
    await advance(5_000);
    expect(onRead).toHaveBeenCalledExactlyOnceWith("bdone0001");
    // A sliver of the second row is not enough; half of its title line is.
    await intersect("bdone0002", 0.2);
    await advance(5_000);
    expect(onRead).toHaveBeenCalledTimes(1);
    await intersect("bdone0002", 0.6);
    await advance(700);
    expect(onRead).toHaveBeenLastCalledWith("bdone0002");
    expect(onRead).toHaveBeenCalledTimes(2);
  });

  it("leaves no observer or timer behind when the thread switches or the drawer closes", async () => {
    using _fakes = setup();
    const onRead = vi.fn();
    await using screen = await render(drawer({ finished: [finishedEntry("bdone0001")], onRead }));
    await intersect("bdone0001", 1);
    expect(vi.getTimerCount()).toBe(1);
    await screen.rerender(
      drawer({ threadId: "thread-2", finished: [finishedEntry("bdone0009")], onRead }),
    );
    expect(
      observers
        .filter((observer) => observer.nodes.some((node) => taskIdOf(node) === "bdone0001"))
        .every((observer) => observer.disconnected),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await intersect("bdone0009", 1);
    await screen.unmount();
    expect(liveObservers()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await advance(5_000);
    expect(onRead).not.toHaveBeenCalled();
  });
});

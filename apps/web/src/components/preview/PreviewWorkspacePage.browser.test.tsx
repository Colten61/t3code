import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import {
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";

import { PreviewWorkspacePage } from "./PreviewWorkspacePage";

// The browser host is external to workspace navigation and must not start a session here.
vi.mock(import("./PreviewView"), async (original) => ({
  ...(await original()),
  PreviewView: (() => null) as never,
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

/** Stands in for the document's fullscreen state for one test. */
function fullscreen(exit: () => Promise<void>): Disposable {
  const element = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
  const exitFullscreen = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    value: document.documentElement,
  });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  return {
    [Symbol.dispose]() {
      for (const [name, descriptor] of [
        ["fullscreenElement", element],
        ["exitFullscreen", exitFullscreen],
      ] as const) {
        if (descriptor) Object.defineProperty(document, name, descriptor);
        else Reflect.deleteProperty(document, name);
      }
    },
  };
}

async function openWorkspace(available = true) {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => "Thread list" }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/$environmentId/$threadId",
        component: () => "Chat",
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/preview",
        component: () => (
          <PreviewWorkspacePage {...(available ? { ...threadRef, tabId: "tab-1" } : {})} />
        ),
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/preview"] }),
  });
  await router.load();
  const screen = await render(<RouterProvider router={router} />, { router: false });
  return { router, screen };
}

async function click(container: HTMLElement, label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

describe("expanded browser preview", () => {
  it("returns to its thread when opened directly without remembered navigation", async () => {
    using _scrollTo = stubGlobal("scrollTo", () => undefined);
    const { router, screen } = await openWorkspace();
    await using _screen = screen;

    await click(screen.container, "Return to chat");

    expect(router.state.location.pathname).toBe("/environment-1/thread-1");
    expect(screen.container.querySelector('[aria-label="Browser workspace"]')).toBeNull();
    expect(
      selectThreadPreviewMiniPlayerTabId(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        threadRef,
      ),
    ).toBeNull();
  });

  it("minimizes into the same thread's floating player", async () => {
    using _scrollTo = stubGlobal("scrollTo", () => undefined);
    const { router, screen } = await openWorkspace();
    await using _screen = screen;

    await click(screen.container, "Minimize preview");

    expect(router.state.location.pathname).toBe("/environment-1/thread-1");
    expect(
      selectThreadPreviewMiniPlayerTabId(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        threadRef,
      ),
    ).toBe("tab-1");
  });

  it.each(["Return to chat", "Minimize preview"])(
    "leaves immediately on %s while fullscreen exit is pending",
    async (label) => {
      using _scrollTo = stubGlobal("scrollTo", () => undefined);
      let finishExit!: () => void;
      const exiting = new Promise<void>((resolve) => {
        finishExit = resolve;
      });
      using _fullscreen = fullscreen(() => exiting);
      const { router, screen } = await openWorkspace();
      await using _screen = screen;

      try {
        await click(screen.container, label);

        expect(router.state.location.pathname).toBe("/environment-1/thread-1");
        expect(screen.container.querySelector('[aria-label="Browser workspace"]')).toBeNull();
      } finally {
        await act(async () => {
          finishExit();
          await exiting;
        });
      }
    },
  );

  it.each(["Return to chat", "Minimize preview"])(
    "can %s when fullscreen exit fails",
    async (label) => {
      using _scrollTo = stubGlobal("scrollTo", () => undefined);
      using _fullscreen = fullscreen(() =>
        Promise.reject(new Error("Fullscreen transition failed")),
      );
      const { router, screen } = await openWorkspace();
      await using _screen = screen;

      await click(screen.container, label);

      expect(router.state.location.pathname).toBe("/environment-1/thread-1");
      expect(screen.container.querySelector('[aria-label="Browser workspace"]')).toBeNull();
    },
  );

  it("can leave an unavailable preview", async () => {
    using _scrollTo = stubGlobal("scrollTo", () => undefined);
    const { router, screen } = await openWorkspace(false);
    await using _screen = screen;

    await click(screen.container, "Return to chat");

    expect(router.state.location.pathname).toBe("/");
    expect(screen.container.querySelector('[aria-label="Browser workspace"]')).toBeNull();
  });
});

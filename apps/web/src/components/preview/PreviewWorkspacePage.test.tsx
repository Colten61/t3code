// @vitest-environment jsdom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";

import { PreviewWorkspacePage } from "./PreviewWorkspacePage";

// The browser host is external to workspace navigation and must not start a session here.
vi.mock("./PreviewView", () => ({ PreviewView: () => null }));

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document, "exitFullscreen");
});

async function openWorkspace(available = true) {
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
  await act(() => root.render(<RouterProvider router={router} />));
  return router;
}

async function click(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

describe("expanded browser preview", () => {
  it("returns to its thread when opened directly without remembered navigation", async () => {
    const router = await openWorkspace();

    await click("Return to chat");

    expect(router.state.location.pathname).toBe("/environment-1/thread-1");
    expect(container.querySelector('[aria-label="Browser workspace"]')).toBeNull();
    expect(
      selectThreadPreviewMiniPlayerTabId(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        threadRef,
      ),
    ).toBeNull();
  });

  it("minimizes into the same thread's floating player", async () => {
    const router = await openWorkspace();

    await click("Minimize preview");

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
      const router = await openWorkspace();
      let finishExit!: () => void;
      const exiting = new Promise<void>((resolve) => {
        finishExit = resolve;
      });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: document.documentElement,
      });
      Object.defineProperty(document, "exitFullscreen", {
        configurable: true,
        value: () => exiting,
      });

      try {
        await click(label);

        expect(router.state.location.pathname).toBe("/environment-1/thread-1");
        expect(container.querySelector('[aria-label="Browser workspace"]')).toBeNull();
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
      const router = await openWorkspace();
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: document.documentElement,
      });
      Object.defineProperty(document, "exitFullscreen", {
        configurable: true,
        value: () => Promise.reject(new Error("Fullscreen transition failed")),
      });

      await click(label);

      expect(router.state.location.pathname).toBe("/environment-1/thread-1");
      expect(container.querySelector('[aria-label="Browser workspace"]')).toBeNull();
    },
  );

  it("can leave an unavailable preview", async () => {
    const router = await openWorkspace(false);

    await click("Return to chat");

    expect(router.state.location.pathname).toBe("/");
    expect(container.querySelector('[aria-label="Browser workspace"]')).toBeNull();
  });
});

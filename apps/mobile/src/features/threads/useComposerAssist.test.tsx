import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
  type UserInputQuestion,
} from "@t3tools/contracts";

const fixture = vi.hoisted(() => ({
  ask: vi.fn(),
  settings: {
    blanks: true,
    contradictions: false,
    spelling: false,
    sentences: false,
    askCues: false,
    auditor: false,
    pauseMs: 500,
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "settings" ? { composerAssist: fixture.settings } : true,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => "settings",
    composerAssist: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.ask }));

import { useComposerAssist } from "./useComposerAssist";

type Input = Parameters<typeof useComposerAssist>[0] & {
  draftKey: string;
  question?: UserInputQuestion;
};
let root: Root;
let input: Input;
let visible: string;
let assist: ReturnType<typeof useComposerAssist>;
function Probe() {
  const state = useComposerAssist(input);
  useLayoutEffect(() => {
    assist = state;
  });
  return null;
}
async function render() {
  await act(() => root.render(<Probe />));
}
async function edit(text: string) {
  visible = text;
  input = { ...input, draft: text };
  await render();
}

beforeEach(() => {
  fixture.ask.mockReset();
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
  visible = "both $status please";
  input = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    instanceId: ProviderInstanceId.make("codex"),
    serverConfig: { environment: { capabilities: { composerAssist: true } } } as ServerConfig,
    draftKey: "request-1:first",
    draft: visible,
    question: {
      id: "first",
      header: "Scope",
      question: "Which issues should be fixed?",
      options: [],
      initialAnswer: visible,
      multiSelect: false,
    },
    active: true,
    onChangeDraft: (text) => {
      visible = text;
    },
  };
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("mobile question assist", () => {
  it("rewrites a literal answer with its question as separate context", async () => {
    fixture.ask.mockResolvedValue({
      _tag: "Success",
      value: {
        operation: "blank",
        blank: { _tag: "rewrite", text: "Both $status, please." },
      },
    });
    await render();
    await edit(`${visible} _`);
    expect(visible).toBe("Both $status, please.");
    const request = fixture.ask.mock.calls[0]?.[0].input;
    expect(request.text).toBe("both $status please _");
    expect(request.answeringQuestion).toBe("Which issues should be fixed?");
  });

  it("keeps a different question's answer when an earlier rewrite arrives", async () => {
    let finish!: (value: unknown) => void;
    fixture.ask.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await edit(`${visible} _`);
    input = {
      ...input,
      draftKey: "request-1:second",
      question: { ...input.question!, id: "second" },
    };
    await render();
    await act(async () => {
      finish({
        _tag: "Success",
        value: {
          operation: "blank",
          blank: { _tag: "rewrite", text: "An answer to the old question" },
        },
      });
    });
    expect(visible).toBe("both $status please _");
    expect(assist.status).toBeNull();
  });

  it("can revert a rewrite after the controlled answer field updates", async () => {
    fixture.ask.mockResolvedValue({
      _tag: "Success",
      value: {
        operation: "blank",
        blank: { _tag: "rewrite", text: "Both $status, please." },
      },
    });
    await render();
    await edit(`${visible} _`);
    input = { ...input, draft: visible };
    await render();
    expect(assist.status?.kind).toBe("rewritten");
    await act(async () => {
      assist.revert();
    });
    expect(visible).toBe("both $status please");
  });

  it("preserves literal answer whitespace when reverting a rewrite", async () => {
    const before = "Text with meaningful trailing whitespace\n\n   ";
    input = { ...input, draft: before, question: { ...input.question!, initialAnswer: before } };
    visible = before;
    fixture.ask.mockResolvedValue({
      _tag: "Success",
      value: { operation: "blank", blank: { _tag: "rewrite", text: "Rewritten text." } },
    });
    await render();
    await edit(`${visible} _`);
    input = { ...input, draft: visible };
    await render();
    await act(async () => {
      assist.revert();
    });
    expect(visible).toBe(before);
  });
});

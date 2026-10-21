import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

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
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => fixture.settings }));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["environment-1", { environment: { capabilities: { composerAssist: true } } }]]),
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { composerAssist: {} } }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => fixture.ask }));

import { useComposerAssist } from "./useComposerAssist";

type Input = Parameters<typeof useComposerAssist>[0] & {
  draftKey: string;
  answer: {
    requestId: string;
    question: {
      id: string;
      question: string;
      options: ReadonlyArray<{ label: string; description: string }>;
      initialAnswer?: string;
      allowCustomAnswer?: boolean;
    };
    text: string;
  } | null;
};
let root: Root;
let input: Input;
let visible: string;
const showCues = vi.fn<NonNullable<Input["editorRef"]["current"]>["showAssistCues"]>();

function Probe() {
  useComposerAssist(input);
  return null;
}

async function render() {
  await act(() => root.render(<Probe />));
}

async function edit(text: string) {
  visible = text;
  input = { ...input, promptRef: { current: text } };
  input = input.answer
    ? { ...input, answer: { ...input.answer, text } }
    : { ...input, prompt: text };
  await render();
}

beforeEach(() => {
  vi.useFakeTimers();
  fixture.ask.mockReset();
  fixture.settings = { ...fixture.settings, spelling: false, auditor: false };
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
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget, setTimeout, clearTimeout });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
  visible = "how can i run tests?";
  showCues.mockReset();
  input = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    instanceId: ProviderInstanceId.make("codex"),
    prompt: visible,
    promptRef: { current: visible },
    draftKey: "thread-1",
    answer: null,
    active: true,
    editorRef: { current: { showAssistCues: showCues } },
    replaceDraft: (expected, next) => {
      if (visible !== expected) return false;
      visible = next;
      return true;
    },
  };
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("composer assist in question fields", () => {
  it("rewrites a question without submitting it", async () => {
    fixture.ask.mockResolvedValue({
      _tag: "Success",
      value: { operation: "blank", blank: { _tag: "rewrite", text: "How can I run the tests?" } },
    });
    await render();
    await edit(`${visible} _`);
    expect(visible).toBe("How can I run the tests?");
  });

  it.each([false, true])(
    "rewrites the visible answer, including literal text: %s",
    async (literal) => {
      input.answer = {
        requestId: "request-1",
        question: {
          id: "scope",
          question: "Should I investigate Working status, permissions, or both?",
          options: [{ label: "Both", description: "Investigate both issues." }],
          ...(literal ? { initialAnswer: "both $status please" } : {}),
        },
        text: "both $status please",
      };
      visible = input.answer.text;
      input = { ...input, promptRef: { current: visible } };
      fixture.ask.mockResolvedValue({
        _tag: "Success",
        value: {
          operation: "blank",
          blank: { _tag: "rewrite", text: literal ? "Both $status, please." : "Both ⟦1⟧, please." },
        },
      });
      await render();
      await edit(`${visible} _`);
      expect(visible).toBe("Both $status, please.");
      expect(input.prompt).toBe("how can i run tests?");
      const request = fixture.ask.mock.calls[0]?.[0].input;
      expect(request.text).toBe(literal ? "both $status please _" : "both ⟦1⟧ please _");
      expect(request.answeringQuestion).toContain(
        "Should I investigate Working status, permissions, or both?",
      );
      expect(request.answeringQuestion).toContain("Both: Investigate both issues.");
    },
  );

  it("drops an in-flight rewrite when a different question shows the same answer", async () => {
    let finish!: (value: unknown) => void;
    fixture.ask.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    input.answer = {
      requestId: "request-1",
      question: { id: "first", question: "Which issue?", options: [] },
      text: "both please",
    };
    visible = input.answer.text;
    input = { ...input, promptRef: { current: visible } };
    await render();
    await edit(`${visible} _`);
    input = {
      ...input,
      answer: { ...input.answer, question: { ...input.answer!.question, id: "second" } },
    } as Input;
    await render();
    await act(async () => {
      finish({
        _tag: "Success",
        value: { operation: "blank", blank: { _tag: "rewrite", text: "Both, please." } },
      });
    });
    expect(fixture.ask).toHaveBeenCalledTimes(1);
    expect(visible).toBe("both please _");
  });

  it("drops an in-flight rewrite after the editor becomes inactive", async () => {
    let finish!: (value: unknown) => void;
    fixture.ask.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await edit(`${visible} _`);
    input = { ...input, active: false };
    await render();
    await act(async () => {
      finish({
        _tag: "Success",
        value: { operation: "blank", blank: { _tag: "rewrite", text: "Replaced after sending" } },
      });
    });
    expect(visible).toBe("how can i run tests? _");
  });

  it("places cues on the visible custom answer after typing pauses", async () => {
    fixture.settings.spelling = true;
    input.answer = {
      requestId: "request-1",
      question: { id: "scope", question: "Which issue?", options: [] },
      text: "the first issue",
    };
    visible = input.answer.text;
    input = { ...input, promptRef: { current: visible } };
    fixture.ask.mockResolvedValue({
      _tag: "Success",
      value: {
        operation: "cues",
        cues: { cues: [{ kind: "spelling", start: 0, end: 3, note: "", alternatives: ["the"] }] },
      },
    });
    await render();
    await edit("teh first issue");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(showCues).toHaveBeenLastCalledWith("teh first issue", [
      expect.objectContaining({
        quote: "teh",
        start: 0,
        end: 3,
        alternatives: ["the"],
      }),
    ]);
    expect(input.prompt).toBe("how can i run tests?");
  });

  it("leaves a choice-only question unchanged", async () => {
    input.answer = {
      requestId: "request-1",
      question: { id: "scope", question: "Which issue?", options: [], allowCustomAnswer: false },
      text: "both please",
    };
    visible = input.answer.text;
    input = { ...input, promptRef: { current: visible } };
    await render();
    await edit(`${visible} _`);
    expect(visible).toBe("both please _");
    expect(fixture.ask).not.toHaveBeenCalled();
  });

  it("drops an in-flight audit when the auditor is disabled but spelling cues stay on", async () => {
    fixture.settings = { ...fixture.settings, spelling: true, auditor: true };
    let finish!: (value: unknown) => void;
    fixture.ask.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await edit("how can i run teh tests?");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fixture.settings = { ...fixture.settings, auditor: false };
    await render();
    await act(async () => {
      finish({
        _tag: "Success",
        value: {
          operation: "cues",
          cues: { cues: [], audit: "A rewrite from the disabled auditor" },
        },
      });
    });
    expect(visible).toBe("how can i run teh tests?");
  });
});

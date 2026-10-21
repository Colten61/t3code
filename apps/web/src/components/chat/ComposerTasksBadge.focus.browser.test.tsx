import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { PendingUserInput } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerTasksBadge } from "./ComposerTasksBadge";
import { isInsideCollapsedComposerControls } from "./composerEventScope";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live" as const,
  createdAt: "2026-10-10T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: false,
    },
  ],
  dismissible: true,
};
const steps = [
  { step: "Read", status: "completed" },
  { step: "Write", status: "inProgress" },
] as const;
const progress = { step: "Write", completedSteps: 1, totalSteps: 2, live: true };

// ChatComposer expands a collapsed composer on focus unless the target is a
// collapsed-composer control (its form's onFocusCapture); an expansion
// remounts the pending question, which resets its disclosure state. This
// mounts the real badge and question beside that same rule.
function CollapsedComposerWithQuestion() {
  const [expanded, setExpanded] = useState(false);
  return (
    <form
      data-expanded={expanded ? "true" : "false"}
      onFocusCapture={(event) => {
        if (isInsideCollapsedComposerControls(event.target)) return;
        setExpanded(true);
      }}
    >
      <ComposerBanner.Root>
        <ComposerTasksBadge
          expanded={false}
          onToggle={() => {}}
          placement="inline"
          progress={progress}
          steps={steps}
        />
      </ComposerBanner.Root>
      <div key={expanded ? "expanded" : "collapsed"} data-chat-composer-collapsed-controls="true">
        <ComposerPendingUserInputPanel
          pendingUserInputs={[prompt]}
          cwd="/repo"
          threadRef={threadRef}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onToggleOption={() => {}}
          onAdvance={() => {}}
          onDismiss={() => {}}
        />
      </div>
      <textarea data-testid="editor" />
    </form>
  );
}

function query(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

describe("Tasks badge focus beside a pending question", () => {
  it("keeps the composer collapsed and the question's disclosure state when the badge is focused", async () => {
    await using screen = await render(<CollapsedComposerWithQuestion />);
    const find = (selector: string) => query(screen.container, selector);
    await act(async () => find("[data-pending-user-input-toggle]").click());
    expect(find("[data-pending-user-input-toggle]").dataset.pendingUserInputToggle).toBe(
      "collapsed",
    );

    await act(async () => find("[data-composer-tasks-badge]").focus());

    expect(document.activeElement).toBe(find("[data-composer-tasks-badge]"));
    expect(find("form").dataset.expanded).toBe("false");
    expect(find("[data-pending-user-input-toggle]").dataset.pendingUserInputToggle).toBe(
      "collapsed",
    );
  });

  it("still expands, and so remounts the question, when another control takes focus", async () => {
    await using screen = await render(<CollapsedComposerWithQuestion />);
    const find = (selector: string) => query(screen.container, selector);
    await act(async () => find("[data-pending-user-input-toggle]").click());
    await act(async () => find('[data-testid="editor"]').focus());

    expect(find("form").dataset.expanded).toBe("true");
    expect(find("[data-pending-user-input-toggle]").dataset.pendingUserInputToggle).toBe(
      "expanded",
    );
  });
});

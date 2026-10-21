// FORK: composer assist in the web composer. A blank typed at the end of the draft (" _") asks
// Claude to rewrite or fill it in; a pause in typing asks for cues, which the editor shows on
// their spans. An answer for a draft that has changed since is dropped, never applied.
import {
  composerAssistAnswer,
  composerAssistQuestionContext,
  composerBlankOutcome,
  composerBlankTooLong,
  composerDraftCues,
  fromComposerAssistText,
  isTypedComposerBlank,
  toComposerAssistDraft,
  wantsComposerCues,
} from "@t3tools/client-runtime/composer-assist";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { collectComposerPromptInlineTokens } from "~/composer-editor-mentions";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useServerConfigs } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";

export type ComposerAssistStatus =
  | { readonly kind: "working" }
  | { readonly kind: "note"; readonly text: string };

const assistDraftOf = (draft: string, literal: boolean) =>
  toComposerAssistDraft(draft, literal ? [] : collectComposerPromptInlineTokens(draft));

export function useComposerAssist(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly prompt: string;
  readonly promptRef: { readonly current: string };
  readonly draftKey: string;
  readonly answer?: {
    readonly requestId: string;
    readonly question: Pick<
      UserInputQuestion,
      "id" | "question" | "options" | "initialAnswer" | "allowCustomAnswer"
    >;
    readonly text: string;
  } | null;
  /** False while the visible editor cannot be changed. */
  readonly active: boolean;
  readonly editorRef: {
    readonly current: Pick<ComposerPromptEditorHandle, "showAssistCues"> | null;
  };
  /** Replaces the whole draft if it still reads `expected`. */
  readonly replaceDraft: (expected: string, next: string) => boolean;
}): ComposerAssistStatus | null {
  const settings = useEnvironmentSettings(input.environmentId, (all) => all.composerAssist);
  const supported =
    useServerConfigs().get(input.environmentId)?.environment.capabilities?.composerAssist === true;
  const permitted = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const enabled =
    supported && permitted && input.active && input.answer?.question.allowCustomAnswer !== false;
  const draft = input.answer?.text ?? input.prompt;
  const draftKey = JSON.stringify([
    input.environmentId,
    input.threadId,
    input.draftKey,
    input.answer?.requestId,
    input.answer?.question.id,
  ]);
  const literal = input.answer?.question.initialAnswer !== undefined;
  const answeringQuestion = input.answer
    ? composerAssistQuestionContext(input.answer.question)
    : undefined;
  const wantsCues =
    settings.contradictions ||
    settings.spelling ||
    settings.sentences ||
    settings.askCues ||
    settings.auditor;
  const askAssist = useAtomCommand(serverEnvironment.composerAssist, { reportFailure: false });
  const [status, setStatus] = useState<ComposerAssistStatus | null>(null);
  const previousPromptRef = useRef({ draft, key: draftKey });
  const answerCountRef = useRef(0);
  // The latest values for the async work below, which outlives a render.
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  useEffect(() => {
    const previous = previousPromptRef.current;
    previousPromptRef.current = { draft, key: draftKey };
    // A status belongs to this run's draft and settings; the next run starts without one.
    const clearStatus = () => setStatus(null);
    if (previous.key !== draftKey || !enabled) {
      latest.current.editorRef.current?.showAssistCues(draft, []);
      return clearStatus;
    }
    if (previous.draft === draft) return clearStatus;
    let current = true;
    const target = {
      ...(input.threadId === null ? {} : { threadId: input.threadId }),
      ...(input.projectId === null ? {} : { projectId: input.projectId }),
      ...(input.instanceId === null ? {} : { instanceId: input.instanceId }),
      ...(answeringQuestion === undefined ? {} : { answeringQuestion }),
    };

    if (settings.blanks && isTypedComposerBlank(previous.draft, draft)) {
      const assist = assistDraftOf(draft, literal);
      latest.current.editorRef.current?.showAssistCues(draft, []);
      if (composerBlankTooLong(assist)) {
        // oxlint-disable-next-line react/set-state-in-effect -- A typed blank is told from the previous draft, which only this effect sees.
        setStatus({ kind: "note", text: "The draft is too long for a blank." });
        return clearStatus;
      }
      setStatus({ kind: "working" });
      void askAssist({
        environmentId: input.environmentId,
        input: { operation: "blank", ...target, text: assist.text },
      }).then((result) => {
        if (!current) return;
        setStatus((current) => (current?.kind === "working" ? null : current));
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const cause = squashAtomCommandFailure(result);
          setStatus({
            kind: "note",
            text: cause instanceof Error ? cause.message : "Claude could not answer the blank.",
          });
          return;
        }
        const answer = composerAssistAnswer(result.value, "blank");
        if (answer === null) return;
        const outcome = composerBlankOutcome(draft, assist, answer.blank);
        if (outcome.kind === "note") setStatus({ kind: "note", text: outcome.text });
        if (outcome.kind !== "replace") return;
        if (!latest.current.replaceDraft(draft, outcome.text)) {
          setStatus({
            kind: "note",
            text: "The draft changed while Claude answered; it was kept.",
          });
        }
      });
      return () => {
        current = false;
        clearStatus();
      };
    }

    if (!wantsCues) return clearStatus;
    if (!wantsComposerCues(draft)) {
      latest.current.editorRef.current?.showAssistCues(draft, []);
      return clearStatus;
    }
    const timer = window.setTimeout(() => {
      if (latest.current.promptRef.current !== draft) return;
      const assist = assistDraftOf(draft, literal);
      void askAssist({
        environmentId: input.environmentId,
        input: { operation: "cues", ...target, text: assist.text },
      }).then((result) => {
        // Cues are optional: a failed check just shows nothing.
        const answer =
          result._tag === "Failure" ? null : composerAssistAnswer(result.value, "cues");
        if (!current || answer === null || latest.current.promptRef.current !== draft) return;
        answerCountRef.current += 1;
        latest.current.editorRef.current?.showAssistCues(
          draft,
          composerDraftCues(draft, assist, answer.cues.cues, `cue-${answerCountRef.current}`),
        );
        const audit = answer.cues.audit;
        if (audit === undefined) return;
        const text = fromComposerAssistText(audit, assist);
        if (text !== null && latest.current.replaceDraft(draft, text)) {
          setStatus({ kind: "note", text: "The auditor tidied the draft. Undo puts it back." });
        }
      });
    }, settings.pauseMs);
    return () => {
      current = false;
      window.clearTimeout(timer);
      clearStatus();
    };
  }, [
    askAssist,
    answeringQuestion,
    draft,
    draftKey,
    enabled,
    input.environmentId,
    input.instanceId,
    input.projectId,
    input.threadId,
    literal,
    settings,
    wantsCues,
  ]);

  return enabled ? status : null;
}

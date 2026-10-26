// @effect-diagnostics nodeBuiltinImport:off - FORK: the plain instruction builders read the local file synchronously
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: one link_pull_request per PR, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never wait with sleep, loops, gh --watch, Monitor, or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

/** FORK: the user's own rules file is cut here, since Cursor and ACP resend it with every turn. */
const LOCAL_INSTRUCTIONS_LIMIT = 16_000;

let localInstructionsCache: { path: string; mtimeMs: number; text: string } | undefined;

/** FORK: `T3CODE_LOCAL_INSTRUCTIONS_FILE` (empty turns it off), else `~/.config/t3code/instructions.md`. */
export function localInstructionsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.T3CODE_LOCAL_INSTRUCTIONS_FILE;
  return configured !== undefined
    ? configured.trim()
    : NodePath.join(NodeOS.homedir(), ".config", "t3code", "instructions.md");
}

/**
 * FORK: the user's own rules for every provider, as a `<local_instructions>` block, or "" when the
 * file is missing, empty or unreadable. Re-read only when its mtime changes.
 */
export function localInstructions(path: string = localInstructionsPath()): string {
  try {
    const { mtimeMs } = NodeFS.statSync(path);
    if (localInstructionsCache?.path !== path || localInstructionsCache.mtimeMs !== mtimeMs) {
      const text = NodeFS.readFileSync(path, "utf8").trim().slice(0, LOCAL_INSTRUCTIONS_LIMIT);
      localInstructionsCache = { path, mtimeMs, text };
    }
    const { text } = localInstructionsCache;
    return text ? `<local_instructions>\n${text}\n</local_instructions>` : "";
  } catch {
    return "";
  }
}

/**
 * FORK: a thread's own instructions (`runtimePolicy.instructions`) as a `<thread_instructions>`
 * block, or "" when it has none.
 */
export function threadInstructions(instructions: string | undefined): string {
  const text = instructions?.trim() ?? "";
  return text ? `<thread_instructions>\n${text}\n</thread_instructions>` : "";
}

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * FORK: the local instructions follow, unless the caller sends them separately (`local: false`),
 * then the thread's own instructions.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly local?: boolean | undefined;
  readonly instructions?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const local = runtime.local === false ? "" : localInstructions();
  const thread = threadInstructions(runtime.instructions);
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in T3 Code's files viewer.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${local ? `\n\n${local}` : ""}${thread ? `\n\n${thread}` : ""}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("thread runtime instructions", () => {
  it("ends with the thread's own instructions, when it has any", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Claude Code",
        instructions: "  Orchestrate the cards.\n",
      }),
    ).toMatch(/\n\n<thread_instructions>\nOrchestrate the cards\.\n<\/thread_instructions>$/);
    expect(buildRuntimeInstructions({ harness: "Claude Code", instructions: "  " })).not.toContain(
      "<thread_instructions>",
    );
  });
});

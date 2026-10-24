import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderInstanceConfig } from "./providerInstance.ts";

const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);

describe("provider instance hard caps", () => {
  it("decodes a hard cap and rejects a capability the server does not know", () => {
    const hardCap = {
      maxRuntimeMode: "approval-required",
      declineFileChanges: true,
      withheldCapabilities: ["orchestration", "pull-requests"],
    };
    expect(decodeProviderInstanceConfig({ driver: "antigravity", hardCap }).hardCap).toEqual(
      hardCap,
    );
    expect(decodeProviderInstanceConfig({ driver: "antigravity" }).hardCap).toBeUndefined();
    expect(() =>
      decodeProviderInstanceConfig({
        driver: "antigravity",
        hardCap: { withheldCapabilities: ["browser"] },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstanceConfig({
        driver: "antigravity",
        hardCap: { maxRuntimeMode: "supervised" },
      }),
    ).toThrow();
  });
});

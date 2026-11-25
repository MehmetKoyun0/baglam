import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_CLIENTS } from "../src/clients/index.js";
import { en } from "../site/src/i18n/en.js";
import { tr } from "../site/src/i18n/tr.js";

const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

describe("release and setup documentation", () => {
  it("publishes stable versions to latest by default", () => {
    const pkg = JSON.parse(read("package.json"));
    if (!pkg.version.includes("-")) expect(pkg.publishConfig.tag).toBe("latest");
  });

  it.each([en, tr])("lists every MCP client and gives the matching setup count", (copy) => {
    expect(copy.common.tools).toHaveLength(ALL_CLIENTS.length);
    expect(copy.tools.list.map(item => item.t).sort()).toEqual([...copy.common.tools].sort());
    expect(copy.home.stats[0].n).toBe(String(ALL_CLIENTS.length));
    expect(copy.common.tools).toContain("Windsurf");
  });

  it("documents the handoff and capture controls in both languages and CLI help", () => {
    for (const path of ["README.md", "README.tr.md", "src/cli.ts"]) {
      expect(read(path)).toContain("BAGLAM_HANDOFF_TTL_DAYS");
      expect(read(path)).toContain("BAGLAM_AUTO_CAPTURE");
    }
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(import.meta.dirname, "..");

describe("stdio entry points (built)", () => {
  beforeAll(() => {
  }, 60_000);

  it.runIf(process.platform === "linux")("keeps the panel available when xdg-open is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baglam-no-opener-"));
    const child = spawn(process.execPath, [join(root, ".test-dist/cli.js"), "ui"], {
      env: { ...process.env, PATH: dir, BAGLAM_DB: join(dir, "panel.db") },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        if (!line.startsWith("Bağlam panel: ")) continue;
        const response = await fetch(line.slice("Bağlam panel: ".length), { redirect: "manual" });
        expect(response.status).toBe(302);
        return;
      }
      throw new Error("panel exited before printing its link");
    } finally {
      lines.close();
      child.kill();
      await closed;
    }
  }, 20_000);

  for (const entry of [[".test-dist/cli.js", "mcp"], [".test-dist/mcp.js"]]) {
    it(`${entry.join(" ")} serves MCP over stdio`, async () => {
      const work = mkdtempSync(join(tmpdir(), "baglam-stdio-"));
      const client = new Client({ name: "stdio-test", version: "1" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: entry.map((p, i) => (i === 0 ? join(root, p) : p)),
          env: { ...process.env, BAGLAM_DB: join(work, "t.db"), BAGLAM_PROJECT: work } as Record<string, string>,
          stderr: "ignore",
        }),
      );
      try {
        const res = await client.callTool({
          name: "context_propose",
          arguments: { kind: "fact", title: "stdio works", body: "yes" },
        });
        expect((res.content as { text: string }[])[0].text).toMatch(/^Proposed c/);
      } finally {
        await client.close();
      }
    }, 20_000);
  }
});

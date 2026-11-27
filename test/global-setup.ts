import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compile src/ once, into .test-dist/, for the tests that need real JS files (child processes).
 * Tests must never rebuild dist/: that folder is what the owner's AI tools run, and a build cut
 * short (or two parallel builds) leaves it broken.
 */
export default function setup(project: TestProject) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out = join(root, ".test-dist");
  rmSync(out, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", out, "--declaration", "false", "--sourceMap", "false"],
    { cwd: root, stdio: "inherit" },
  );
  // Workers and their child processes put all fixtures under this run's private directory.
  const temp = mkdtempSync(join(tmpdir(), "baglam-tests-"));
  project.config.env = { ...project.config.env, TMPDIR: temp, TMP: temp, TEMP: temp };
  return () => rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
}

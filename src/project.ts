import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, normalizeProject, UUID } from "./config.js";

export interface ProjectRef {
  /** Marker id when initialised, else the normalised folder path (v0.1 key). */
  key: string;
  name: string;
  /** Folder the project lives in (marker folder, git root or the folder itself). */
  dir: string;
  initialized: boolean;
  /** What identified the project: a marker file, a git root, or just the folder itself. */
  anchor: "marker" | "git" | "folder";
  /** Set when a marker exists but cannot be used. */
  warning?: string;
}

const MARKER_DIR = ".baglam";
const MARKER_FILE = "project.json";
const markerPath = (dir: string) => join(dir, MARKER_DIR, MARKER_FILE);

/** Bağlam's own package folder (works from both src/ and dist/). */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Read `<dir>/.baglam/project.json`. null = no marker; `{ error }` = present but unusable. */
export function readMarker(dir: string): { id: string; name: string } | { error: string } | null {
  const file = markerPath(dir);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown; name?: unknown };
    if (typeof data.id !== "string" || !data.id.trim()) return { error: `${file} has no "id"` };
    if (!UUID.test(data.id.trim())) return { error: `${file} has an invalid project id` };
    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : basename(dir);
    return { id: data.id.trim(), name };
  } catch (err) {
    return { error: `${file} is not valid JSON (${(err as Error).message})` };
  }
}

/** Folders that are never a project themselves. */
function exactUnsafe(): string[] {
  return [homedir(), PACKAGE_ROOT].map(normalizeProject);
}

/** Folders whose whole subtree is system or application territory. */
function unsafeTrees(): string[] {
  const env = process.env;
  const trees =
    process.platform === "win32"
      ? [
          env.WINDIR ?? env.SystemRoot,
          env.ProgramFiles,
          env["ProgramFiles(x86)"],
          env.ProgramData,
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"),
        ]
      : ["/bin", "/sbin", "/usr", "/etc", "/System", "/Library", "/Applications", "/private/var", "/proc", "/sys"];
  return trees.filter((t): t is string => !!t).map(normalizeProject);
}

/** True for folders that must never be treated as a project. */
export function isUnsafeProjectDir(dir: string): boolean {
  const p = normalizeProject(dir);
  if (p === normalizeProject(parse(resolve(dir)).root)) return true;
  if (exactUnsafe().includes(p)) return true;
  return unsafeTrees().some((t) => p === t || p.startsWith(t + "/"));
}

/** Nearest folder at or above `start` holding a marker (usable or not). Unsafe folders never count. */
function findMarkerDir(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(markerPath(dir)) && !isUnsafeProjectDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Map any folder to its project: nearest marker, else git root, else the folder itself. */
export function resolveDirectory(dir: string): ProjectRef {
  const start = resolve(dir);
  const markerDir = findMarkerDir(start);
  let warning: string | undefined;
  if (markerDir) {
    const marker = readMarker(markerDir);
    if (marker && "id" in marker) {
      return { key: marker.id, name: marker.name, dir: markerDir, initialized: true, anchor: "marker" };
    }
    warning = `Ignoring ${marker?.error ?? markerPath(markerDir)}. Run "baglam init" to repair it.`;
  }
  const gitRoot = findProjectRoot(start);
  const hasGit = existsSync(join(gitRoot, ".git"));
  // A git repo at the home folder (dotfiles) must not swallow every project below it.
  const useGit = hasGit && !(isUnsafeProjectDir(gitRoot) && !isUnsafeProjectDir(start));
  const root = useGit ? gitRoot : start;
  return {
    key: normalizeProject(root),
    name: basename(root) || root,
    dir: root,
    initialized: false,
    anchor: useGit ? "git" : "folder",
    warning,
  };
}

/** Give `dir` a stable identity. Keeps an existing valid marker (updating name if given); replaces a corrupt one. */
export function createMarker(dir: string, reuse?: { id?: string; name?: string }): ProjectRef {
  const target = resolve(dir);
  if (isUnsafeProjectDir(target)) {
    throw new Error(`${target} cannot be a project (home, system or Bağlam's own folder). Run this inside a project folder.`);
  }
  const wantedName = reuse?.name?.trim() || undefined;
  const existing = readMarker(target);
  if (existing && "id" in existing) {
    if (wantedName && wantedName !== existing.name) {
      const updated = { id: existing.id, name: wantedName };
      writeFileSync(markerPath(target), JSON.stringify(updated, null, 2) + "\n");
      return { key: existing.id, name: wantedName, dir: target, initialized: true, anchor: "marker" };
    }
    return { key: existing.id, name: existing.name, dir: target, initialized: true, anchor: "marker" };
  }
  // A repaired marker keeps the identity the folder had, so its records stay with it.
  const marker = { id: reuse?.id?.trim() || randomUUID(), name: wantedName ?? basename(target) };
  mkdirSync(join(target, MARKER_DIR), { recursive: true });
  writeFileSync(markerPath(target), JSON.stringify(marker, null, 2) + "\n");
  return { key: marker.id, name: marker.name, dir: target, initialized: true, anchor: "marker" };
}

/** Project key for CLI use: explicit path or BAGLAM_PROJECT, else the folder containing cwd. */
export function resolveProject(explicit?: string, cwd = process.cwd()): string {
  const fromEnv = explicit ?? process.env.BAGLAM_PROJECT;
  return resolveDirectory(fromEnv?.trim() ? fromEnv : cwd).key;
}

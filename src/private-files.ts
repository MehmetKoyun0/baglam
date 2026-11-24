import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function ensureDataDirectory(file: string): void {
  const dir = dirname(resolve(file));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A custom database may live directly in a project or home directory.
  if (process.platform !== "win32" && dir === join(homedir(), ".baglam")) chmodSync(dir, 0o700);
}

/** Tighten files from older installations. SQLite sidecars can disappear on last close. */
export function protectExisting(file: string): boolean {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error("Expected a regular data file: " + file);
    if ((stat.mode & 0o777) !== 0o600) chmodSync(file, 0o600);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export function prepareDatabaseFiles(file: string): void {
  ensureDataDirectory(file);
  if (process.platform === "win32") return;
  if (!protectExisting(file)) {
    try {
      closeSync(openSync(file, "wx", 0o600));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !protectExisting(file)) throw err;
    }
  }
  protectExisting(join(dirname(file), "hook-errors.log"));
  // SQLite creates subsequent WAL/SHM files using the main database's mode.
  for (const suffix of ["-wal", "-shm", "-journal"]) protectExisting(file + suffix);
}

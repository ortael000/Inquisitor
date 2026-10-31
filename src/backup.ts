/**
 * Creates consistent SQLite backups and checks restoration using a temporary copy.
 * Contains schema and integrity checks, article counting, and temporary-file cleanup.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertSchema } from "./database.js";
import { CollectionError } from "./errors.js";

export function backupDatabase(source: string, destination: string): void {
  if (resolve(source) === resolve(destination) || existsSync(destination)) throw new CollectionError("CONFIGURATION");
  mkdirSync(dirname(destination), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    assertSchema(db, true);
    // VACUUM INTO produces a consistent standalone copy, including committed WAL data.
    db.prepare("VACUUM INTO ?").run(resolve(destination));
  } finally { db.close(); }
}

export function restoreCheck(backupPath: string): number {
  const directory = mkdtempSync(join(tmpdir(), "inquisitor-restore-"));
  const restored = join(directory, "restored.sqlite");
  try {
    copyFileSync(backupPath, restored);
    const db = new DatabaseSync(restored, { readOnly: true });
    try {
      assertSchema(db, true);
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new CollectionError("DATABASE");
      return Number(db.prepare("SELECT count(*) AS count FROM articles").get()!.count);
    } finally { db.close(); }
  } finally {
    // Only the explicitly created temporary files are removed; never touch the source.
    rmSync(restored, { force: true });
    rmdirSync(directory);
  }
}

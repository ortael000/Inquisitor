/**
 * Provides the command-line entry point for database setup, collection, backups,
 * and restore checks, including argument parsing, source selection, and error reporting.
 */

import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { CollectionError, safeCode } from "./errors.js";
import { openDatabase } from "./database.js";
import { backupDatabase, restoreCheck } from "./backup.js";
import { collect } from "./collection.js";
import { validateRange } from "./normalize.js";
import { benzingaCollector } from "./sources/benzinga.js";
import { marketauxCollector } from "./sources/marketaux.js";
import { configuredSource } from "./coverage.js";
import { finnhubCollector } from "./sources/finnhub.js";
import { secEdgarCollector, secSelection } from "./sources/sec-edgar.js";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    db: { type: "string", default: "data/inquisitor.sqlite" },
    from: { type: "string" }, to: { type: "string" }, sources: { type: "string" },
    "continue-on-error": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    attempts: { type: "string", default: "1" }, output: { type: "string" }, input: { type: "string" },
  } });
  const command = positionals[0];
  if (positionals.length !== 1) throw new CollectionError("CONFIGURATION");
  if (command === "setup") {
    openDatabase(values.db, true).close();
    console.log("Article database ready.");
  } else if (command === "backup") {
    if (!values.output) throw new CollectionError("CONFIGURATION");
    backupDatabase(values.db, values.output);
    console.log("Consistent SQLite backup created.");
  } else if (command === "restore-check") {
    if (!values.input) throw new CollectionError("CONFIGURATION");
    console.log(JSON.stringify({ status: "restored", articles: restoreCheck(values.input) }));
  } else if (command === "collect") {
    if (!values.from || !values.to) throw new CollectionError("VALIDATION");
    const range = { from: values.from, to: values.to };
    validateRange(range);
    const config = loadConfig();
    const registry = [
      configuredSource("benzinga", config.benzinga, benzingaCollector),
      configuredSource("marketaux", config.marketaux, marketauxCollector),
      configuredSource("finnhub", config.finnhub, finnhubCollector),
      configuredSource("sec_edgar", config.sec_edgar, secEdgarCollector, 1, secSelection),
    ];
    const selected = values.sources?.split(",");
    if (selected?.some(name => !registry.some(s => s.name === name && s.enabled))) throw new CollectionError("CONFIGURATION");
    const sources = registry.filter(s => !selected || selected.includes(s.name));
    if (!sources.some(s => s.enabled)) throw new CollectionError("CONFIGURATION");
    const db = openDatabase(values.db);
    try {
      const result = await collect(db, sources, range, {
        continueOnError: values["continue-on-error"], attempts: Number(values.attempts), force: values.force,
      });
      if (result.failed) process.exitCode = 1;
    } finally { db.close(); }
  } else throw new CollectionError("CONFIGURATION");
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: safeCode(error) }));
  process.exitCode = 1;
}

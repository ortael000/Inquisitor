/**
 * Loads source configuration and validates collection prerequisites. Contains
 * configuration types and checks for access verification, limits, ranges, and credentials.
 */

import { readFileSync } from "node:fs";
import { CollectionError } from "./errors.js";
import { instant, validateRange } from "./normalize.js";
import type { PublicationRange } from "./types.js";

export interface SourceConfig {
  enabled: boolean;
  symbols: string[];
  tokenEnv?: string;
  auth?: "token" | "none";
  // Set only after checking the contracted product and an entitled probe.
  accessVerified: boolean;
  englishVerified: boolean;
  mappingVerified: boolean;
  historyFrom?: string;
  historyTo?: string;
  pageSize: number;
  maxPages: number;
  maxItems: number;
  maxBytes: number;
  timeoutMs: number;
  requestIntervalMs?: number;
}

export interface Config {
  benzinga: SourceConfig;
  marketaux?: SourceConfig;
  finnhub?: SourceConfig;
  sec_edgar?: SecConfig;
}

export interface SecConfig extends SourceConfig {
  userAgentEnv: string;
  ciks?: Record<string, string>;
  forms?: string[];
  includeExhibits?: boolean;
  maxDocumentBytes?: number;
  maxFilingBytes?: number;
}

export function loadConfig(): Config {
  try {
    const parsed: Config = JSON.parse(readFileSync(process.env.INQUISITOR_CONFIG ?? "config/sources.json", "utf8"));
    if (!parsed.benzinga || typeof parsed.benzinga.enabled !== "boolean") throw new Error();
    for (const name of ["marketaux", "finnhub", "sec_edgar"] as const) {
      if (parsed[name] && typeof parsed[name].enabled !== "boolean") throw new Error();
    }
    return parsed;
  } catch { throw new CollectionError("CONFIGURATION"); }
}

export function validateSource(config: SourceConfig, range: PublicationRange): string | undefined {
  validateRange(range);
  if (!config.enabled || !config.accessVerified || !config.englishVerified || !config.mappingVerified
    || !Array.isArray(config.symbols) || config.symbols.length === 0
    || config.symbols.some(s => typeof s !== "string" || !/^[A-Za-z0-9._^-]+$/.test(s))
    || (config.auth !== undefined && !["token", "none"].includes(config.auth))) {
    throw new CollectionError("CONFIGURATION");
  }
  for (const key of ["pageSize", "maxPages", "maxItems", "maxBytes", "timeoutMs"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new CollectionError("CONFIGURATION");
  }
  if (config.requestIntervalMs !== undefined
    && (!Number.isSafeInteger(config.requestIntervalMs) || config.requestIntervalMs < 0)) {
    throw new CollectionError("CONFIGURATION");
  }
  if (config.historyFrom && instant(range.from) < instant(config.historyFrom)) {
    throw new CollectionError("UNSUPPORTED_RANGE");
  }
  if (config.historyTo && instant(range.to) > instant(config.historyTo)) {
    throw new CollectionError("UNSUPPORTED_RANGE");
  }
  if (config.auth === "none") return undefined;
  if (typeof config.tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(config.tokenEnv)) throw new CollectionError("CONFIGURATION");
  const token = process.env[config.tokenEnv];
  if (!token?.trim()) throw new CollectionError("AUTHENTICATION");
  return token;
}

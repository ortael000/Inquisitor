/**
 * Defines reusable daily coverage rules and binds a source's selection fingerprint
 * to the same configuration used for retrieval. Storage belongs to ingestion.
 */

import type { SourceConfig } from "./config.js";
import { CollectionError } from "./errors.js";
import { hash, instant } from "./normalize.js";
import type { PublicationRange, Source, SourceFunction } from "./types.js";

const dayMs = 86_400_000;

/** Only an entire UTC day ending before or at today's UTC midnight is final. */
export function pastFullDay(range: PublicationRange, now: Date): string | undefined {
  const from = instant(range.from), to = instant(range.to);
  const today = Math.floor(now.getTime() / dayMs) * dayMs;
  return from % dayMs === 0 && to - from === dayMs && to <= today
    ? new Date(from).toISOString().slice(0, 10) : undefined;
}

/** Register every provider this way to enable coverage without database code in adapters. */
export function configuredSource<C extends SourceConfig>(
  name: string,
  config: C | undefined,
  factory: (config: C) => SourceFunction,
  version = 1,
  selection?: (config: C) => unknown,
): Source {
  if (!config) return { name, enabled: false, collect: async () => { throw new CollectionError("CONFIGURATION"); } };
  // Freeze a private snapshot so selection and retrieval cannot silently diverge.
  const settings = structuredClone(config);
  const scope: unknown[] = [version, "en", [...new Set(settings.symbols)].sort()];
  if (selection) scope.push(selection(settings));
  return {
    name, enabled: settings.enabled,
    // Bump version when mapping, eligibility, fixed filters, or content access changes.
    // Credentials and operational limits do not change the selected dataset.
    coverageKey: hash(scope),
    collect: factory(settings),
  };
}

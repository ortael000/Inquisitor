/**
 * Selects the first usable provider text in preference order. Adapters specify
 * whether each candidate is full content or a summary; no text is invented.
 */

import { CollectionError } from "../errors.js";
import { plainText, usableContent } from "../normalize.js";
import type { NormalizedArticle } from "../types.js";

export function selectContent(title: string, candidates: readonly {
  value: unknown; kind: NormalizedArticle["contentKind"];
}[]): Pick<NormalizedArticle, "content" | "contentKind"> {
  for (const candidate of candidates) {
    const content = plainText(candidate.value);
    if (usableContent(content, title)) return { content, contentKind: candidate.kind };
  }
  throw new CollectionError("VALIDATION");
}

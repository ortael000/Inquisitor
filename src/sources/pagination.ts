/**
 * Guards bounded page enumeration and repeated pages. Completion rules remain
 * in provider adapters; guard state belongs to one query stream.
 */

import { CollectionError } from "../errors.js";
import { hash } from "../normalize.js";

export class PageGuard {
  private pages = 0;
  private readonly signatures = new Set<string>();
  constructor(private readonly maxPages: number) {}

  /** Check before issuing the next request, so caps cannot cause an extra fetch. */
  next(): void {
    if (++this.pages > this.maxPages) throw new CollectionError("TOO_LARGE");
  }

  /** Check raw items before mapping; invalid items still count as page contents. */
  check(items: unknown[]): void {
    if (!items.length) return;
    const signature = hash(items);
    if (this.signatures.has(signature)) throw new CollectionError("INCOMPLETE");
    this.signatures.add(signature);
  }
}


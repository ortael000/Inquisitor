/**
 * Provides shared HTTP helpers for source adapters: bounded JSON fetching with
 * timeouts, safe transport errors, object validation, and byte and item budgets.
 */

import { parse } from "lossless-json";
import { CollectionError } from "../errors.js";
import type { SourceConfig } from "../config.js";

export type Transport = (url: URL, headers: Record<string, string>, timeoutMs: number,
  maxBytes: number) => Promise<{ data: unknown; bytes: number }>;
export type ByteTransport = (url: URL, headers: Record<string, string>, timeoutMs: number,
  maxBytes: number) => Promise<{ data: Uint8Array; bytes: number; mediaType: string }>;

async function readBody(response: Response, maxBytes: number) {
  if (!response.body) throw new CollectionError("INCOMPLETE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new CollectionError("TOO_LARGE");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return { data: Buffer.concat(chunks), bytes };
}

export const requestBytes: ByteTransport = async (url, headers, timeoutMs, maxBytes) => {
  try {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      // Marketaux reports exhausted daily quota as HTTP 402, not HTTP 429.
      // Inspect only a bounded error body and never expose its message or payload.
      if (response.status === 402) {
        const body = await readBody(response, Math.min(maxBytes, 16384));
        let errorCode: unknown;
        try { errorCode = JSON.parse(body.data.toString("utf8"))?.error?.code; } catch {}
        if (errorCode === "usage_limit_reached") throw new CollectionError("RATE_LIMIT");
        throw new CollectionError("INCOMPLETE");
      }
      await response.body?.cancel();
      if (response.status === 401) throw new CollectionError("AUTHENTICATION");
      if (response.status === 403) throw new CollectionError("ENTITLEMENT");
      if (response.status === 429) {
        const raw = response.headers.get("retry-after");
        const delay = raw ? (/^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : 0;
        throw new CollectionError("RATE_LIMIT", !(delay > 60000), Number.isFinite(delay) ? Math.max(0, Math.min(delay, 60000)) : undefined);
      }
      throw new CollectionError(response.status >= 500 ? "TRANSPORT" : "INCOMPLETE", response.status >= 500);
    }
    return { ...await readBody(response, maxBytes), mediaType: response.headers.get("content-type") ?? "" };
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    throw new CollectionError("TRANSPORT", true);
  }
};

export const requestJson: Transport = async (url, headers, timeoutMs, maxBytes) => {
  const response = await requestBytes(url, headers, timeoutMs, maxBytes);
  try { return { data: parse(Buffer.from(response.data).toString("utf8")), bytes: response.bytes }; }
  catch { throw new CollectionError("INCOMPLETE"); }
};

export type RecordValue = Record<string, any>;
export function record(value: unknown, code: "INCOMPLETE" | "VALIDATION" = "INCOMPLETE"): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CollectionError(code);
  return value as RecordValue;
}

// Count raw candidates as well as bytes, including rejected/out-of-range items.
export class Budget {
  private items = 0;
  private bytes = 0;
  constructor(private readonly config: SourceConfig, private readonly transport: Transport,
    private readonly bytesTransport: ByteTransport = requestBytes) {}
  async get(url: URL, headers: Record<string, string>): Promise<unknown> {
    if (this.bytes >= this.config.maxBytes) throw new CollectionError("TOO_LARGE");
    const response = await this.transport(url, headers, this.config.timeoutMs, this.config.maxBytes - this.bytes);
    this.bytes += response.bytes;
    if (this.bytes > this.config.maxBytes) throw new CollectionError("TOO_LARGE");
    return response.data;
  }
  addItems(count: number) {
    this.items += count;
    if (this.items > this.config.maxItems) throw new CollectionError("TOO_LARGE");
  }
  async getBytes(url: URL, headers: Record<string, string>, maxBytes: number) {
    if (this.bytes >= this.config.maxBytes) throw new CollectionError("TOO_LARGE");
    const remaining = Math.min(maxBytes, this.config.maxBytes - this.bytes);
    const response = await this.bytesTransport(url, headers, this.config.timeoutMs, remaining);
    this.bytes += response.bytes;
    if (response.bytes > remaining || this.bytes > this.config.maxBytes) throw new CollectionError("TOO_LARGE");
    return response;
  }
}

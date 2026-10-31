/**
 * Defines collection error codes and retryability, plus a safe error mapper
 * that keeps underlying exception details out of command output.
 */

export type ErrorCode = "CONFIGURATION" | "AUTHENTICATION" | "ENTITLEMENT"
  | "UNSUPPORTED_RANGE" | "RATE_LIMIT" | "TRANSPORT" | "INCOMPLETE"
  | "TOO_LARGE" | "VALIDATION" | "DATABASE" | "EXTRACTION" | "OCR_REQUIRED";

export class CollectionError extends Error {
  constructor(public readonly code: ErrorCode, public readonly retryable = false, public readonly retryAfterMs?: number) {
    super(code);
  }
}

// Never expose underlying exceptions: transport errors can contain signed URLs or tokens.
export function safeCode(error: unknown): ErrorCode {
  return error instanceof CollectionError ? error.code : "DATABASE";
}

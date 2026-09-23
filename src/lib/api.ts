import { NextResponse } from "next/server";
import { ZodError } from "zod";

// ============================================================
// Consistent API error/success envelope (spec §32).
// Never leaks stack traces, SQL, paths or internals.
// ============================================================

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}

export function jsonOk<T>(data: T, status = 200): NextResponse<{ data: T }> {
  return NextResponse.json({ data }, { status });
}

// Wrap a route handler with unified error mapping.
export function handleApiError(err: unknown): NextResponse<ApiErrorBody> {
  if (err instanceof ApiError) {
    return jsonError(err.status, err.code, err.message, err.details);
  }
  if (err instanceof ZodError) {
    return jsonError(422, "VALIDATION_ERROR", "Request validation failed.", {
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  // Prisma unique constraint
  if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002") {
    return jsonError(409, "CONFLICT", "A record with the same unique value already exists.");
  }
  if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2025") {
    return jsonError(404, "NOT_FOUND", "Resource not found.");
  }
  console.error("[api] unhandled error:", err);
  return jsonError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
}

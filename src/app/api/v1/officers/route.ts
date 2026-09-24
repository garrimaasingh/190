import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listQuerySchema } from "@/lib/validation";
import { OFFICER_STATUSES, OFFICER_ROLES, PAGE_SIZES } from "@/lib/constants";

export const runtime = "nodejs";

// GET /api/v1/officers — platform-wide Officer Directory.
// Scoping is server-derived from the authenticated identity:
//   SYSTEM_ADMIN / AUDITOR → all departments (read)
//   DEPARTMENT_ADMIN / OFFICER → own department only
export async function GET(req: Request) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.OFFICER_READ);
    const url = new URL(req.url);
    const q = listQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const where: Record<string, unknown> = {};
    if (ctx.officer.role !== "SYSTEM_ADMIN" && ctx.officer.role !== "AUDITOR") {
      where.departmentId = ctx.officer.departmentId;
    }
    if (q.search) {
      where.OR = [
        { name: { contains: q.search } },
        { officerId: { contains: q.search.toUpperCase() } },
        { email: { contains: q.search.toLowerCase() } },
      ];
    }
    if (q.status && (OFFICER_STATUSES as readonly string[]).includes(q.status)) where.status = q.status;
    if (q.role && (OFFICER_ROLES as readonly string[]).includes(q.role)) where.role = q.role;
    if (q.departmentId && (ctx.officer.role === "SYSTEM_ADMIN" || ctx.officer.role === "AUDITOR")) {
      where.departmentId = q.departmentId;
    }

    const pageSize = Math.min(q.pageSize || PAGE_SIZES.DEFAULT, PAGE_SIZES.MAX);
    const [total, rows] = await Promise.all([
      db.officer.count({ where }),
      db.officer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, officerId: true, name: true, email: true, designation: true,
          role: true, status: true, lastLoginAt: true, createdAt: true,
          department: { select: { id: true, name: true, departmentType: true } },
        },
      }),
    ]);

    return jsonOk({ items: rows, total, page: q.page, pageSize });
  } catch (err) {
    return handleApiError(err);
  }
}

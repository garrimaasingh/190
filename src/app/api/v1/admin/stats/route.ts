import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";

export const runtime = "nodejs";

// GET /api/v1/admin/stats — Central Admin Dashboard statistics (spec §21)
export async function GET(req: Request) {
  try {
    await requirePermission(req, PERMISSIONS.PLATFORM_STATS_READ);

    const [countries, states, districts, cities, departments, activeDepartments, inactiveDepartments, pendingDepartments, officers, activeOfficers] =
      await Promise.all([
        db.country.count(),
        db.state.count(),
        db.district.count(),
        db.city.count(),
        db.department.count(),
        db.department.count({ where: { status: "ACTIVE" } }),
        db.department.count({ where: { status: "INACTIVE" } }),
        db.department.count({ where: { status: "PENDING" } }),
        db.officer.count(),
        db.officer.count({ where: { status: "ACTIVE" } }),
      ]);

    return jsonOk({
      geography: { countries, states, districts, cities },
      departments: { total: departments, active: activeDepartments, inactive: inactiveDepartments, pending: pendingDepartments },
      officers: { total: officers, active: activeOfficers },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

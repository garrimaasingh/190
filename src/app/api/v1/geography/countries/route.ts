import { db } from "@/lib/db";
import { handleApiError, jsonOk } from "@/lib/api";

export const runtime = "nodejs";

// GET /api/v1/geography/countries
export async function GET() {
  try {
    const countries = await db.country.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, createdAt: true },
    });
    return jsonOk(countries);
  } catch (err) {
    return handleApiError(err);
  }
}

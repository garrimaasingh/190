import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { ERROR_CODES } from "@/lib/constants";

// ============================================================
// Geographic hierarchy validation (spec §27).
// The backend NEVER trusts frontend dropdown selection:
//   city must belong to district, district to state,
//   state to country — and the department record must carry
//   the full consistent chain.
// ============================================================

export interface GeoChain {
  countryId: string;
  stateId: string;
  districtId: string;
  cityId: string;
}

export interface ResolvedGeo {
  country: { id: string; name: string; code: string };
  state: { id: string; name: string; code: string; countryId: string };
  district: { id: string; name: string; code: string; stateId: string };
  city: { id: string; name: string; code: string; districtId: string };
}

export async function resolveAndValidateGeoChain(input: {
  stateId: string;
  districtId: string;
  cityId: string;
  requireActive?: boolean;
}): Promise<ResolvedGeo> {
  const { stateId, districtId, cityId, requireActive = true } = input;

  const city = await db.city.findUnique({ where: { id: cityId }, include: { district: true } });
  if (!city) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "City not found.");

  const district = await db.district.findUnique({ where: { id: districtId } });
  if (!district) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "District not found.");

  const state = await db.state.findUnique({ where: { id: stateId }, include: { country: true } });
  if (!state) throw new ApiError(404, ERROR_CODES.NOT_FOUND, "State not found.");

  if (city.districtId !== district.id) {
    throw new ApiError(
      422,
      ERROR_CODES.GEOGRAPHY_HIERARCHY_INVALID,
      "City does not belong to the selected district."
    );
  }
  if (district.stateId !== state.id) {
    throw new ApiError(
      422,
      ERROR_CODES.GEOGRAPHY_HIERARCHY_INVALID,
      "District does not belong to the selected state."
    );
  }
  // state.countryId is guaranteed by FK; country existence implied by relation.
  if (requireActive) {
    if (city.status !== "ACTIVE" || district.status !== "ACTIVE" || state.status !== "ACTIVE") {
      throw new ApiError(
        422,
        ERROR_CODES.GEOGRAPHY_HIERARCHY_INVALID,
        "Selected geographic units are not active."
      );
    }
  }

  return {
    country: { id: state.country.id, name: state.country.name, code: state.country.code },
    state: { id: state.id, name: state.name, code: state.code, countryId: state.countryId },
    district: { id: district.id, name: district.name, code: district.code, stateId: district.stateId },
    city: { id: city.id, name: city.name, code: city.code, districtId: city.districtId },
  };
}

// Stable identifier fragments used in Department / Officer IDs (spec §7/§12)
export function geoCodeFragments(geo: ResolvedGeo): { stateCode: string; cityCode: string } {
  const sanitize = (s: string) =>
    s.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() || "XXXX";
  return { stateCode: sanitize(geo.state.code), cityCode: sanitize(geo.city.code) };
}

export async function getCountryByCode(code: string) {
  return db.country.findUnique({ where: { code } });
}

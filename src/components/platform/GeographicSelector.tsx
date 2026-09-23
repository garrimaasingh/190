"use client";

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type CountryRow, type StateRow, type DistrictRow, type CityRow } from "@/lib/client/api";

// ============================================================
// Cascading geographic selector (spec §37).
// Country → State → District → City
//  - dependent selects reset and disable when parent changes
//  - options always load from the backend APIs — geography is
//    never hard-coded in the frontend
//  - the backend re-validates the chosen chain
// ============================================================

export interface GeoSelection {
  countryId?: string;
  stateId?: string;
  districtId?: string;
  cityId?: string;
}

export function GeographicSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: GeoSelection;
  onChange: (next: GeoSelection) => void;
  disabled?: boolean;
}) {
  const [countries, setCountries] = React.useState<CountryRow[]>([]);
  const [states, setStates] = React.useState<StateRow[]>([]);
  const [districts, setDistricts] = React.useState<DistrictRow[]>([]);
  const [cities, setCities] = React.useState<CityRow[]>([]);
  const [loadError, setLoadError] = React.useState(false);

  React.useEffect(() => {
    api
      .get<CountryRow[]>("/api/v1/geography/countries")
      .then(setCountries)
      .catch(() => setLoadError(true));
  }, []);

  React.useEffect(() => {
    if (!value.countryId) return setStates([]);
    api.get<StateRow[]>(`/api/v1/geography/states?countryId=${value.countryId}`).then(setStates).catch(() => setStates([]));
  }, [value.countryId]);

  React.useEffect(() => {
    if (!value.stateId) return setDistricts([]);
    api.get<DistrictRow[]>(`/api/v1/geography/states/${value.stateId}/districts`).then(setDistricts).catch(() => setDistricts([]));
  }, [value.stateId]);

  React.useEffect(() => {
    if (!value.districtId) return setCities([]);
    api.get<CityRow[]>(`/api/v1/geography/districts/${value.districtId}/cities`).then(setCities).catch(() => setCities([]));
  }, [value.districtId]);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Geographic selector">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="geo-country">Country</label>
        <Select
          value={value.countryId || "__none__"}
          onValueChange={(v) => onChange({ countryId: v === "__none__" ? undefined : v })}
          disabled={disabled || loadError}
        >
          <SelectTrigger id="geo-country" aria-label="Select country" className="w-full">
            <SelectValue placeholder={loadError ? "Failed to load" : "Select country"} />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {countries.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="geo-state">State</label>
        <Select
          value={value.stateId || "__none__"}
          onValueChange={(v) => onChange({ ...value, stateId: v === "__none__" ? undefined : v, districtId: undefined, cityId: undefined })}
          disabled={disabled || !value.countryId}
        >
          <SelectTrigger id="geo-state" aria-label="Select state" className="w-full">
            <SelectValue placeholder={value.countryId ? "Select state" : "Select country first"} />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {states.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="geo-district">District</label>
        <Select
          value={value.districtId || "__none__"}
          onValueChange={(v) => onChange({ ...value, districtId: v === "__none__" ? undefined : v, cityId: undefined })}
          disabled={disabled || !value.stateId}
        >
          <SelectTrigger id="geo-district" aria-label="Select district" className="w-full">
            <SelectValue placeholder={value.stateId ? "Select district" : "Select state first"} />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {districts.map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="geo-city">City</label>
        <Select
          value={value.cityId || "__none__"}
          onValueChange={(v) => onChange({ ...value, cityId: v === "__none__" ? undefined : v })}
          disabled={disabled || !value.districtId}
        >
          <SelectTrigger id="geo-city" aria-label="Select city" className="w-full">
            <SelectValue placeholder={value.districtId ? "Select city" : "Select district first"} />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {cities.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

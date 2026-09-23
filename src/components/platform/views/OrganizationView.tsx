"use client";

import * as React from "react";
import { useAuth, hasPermission } from "@/lib/client/store";
import { api, type CountryRow, type StateRow, type DistrictRow, type CityRow, type DepartmentListItem } from "@/lib/client/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge, TypeBadge, LoadingState, ErrorState, EmptyState, GeographicBreadcrumb } from "@/components/platform/common";
import { ChevronRight, Globe2, Map, MapPin, Building, Building2, Plus } from "lucide-react";

// ============================================================
// Geographic explorer (spec §21/§53): India → State → District
// → City → Departments. SYSTEM_ADMIN can extend the hierarchy.
// ============================================================

export function OrganizationView({ onOpenDepartment }: { onOpenDepartment?: (id: string) => void }) {
  const { me } = useAuth();
  const [countries, setCountries] = React.useState<CountryRow[] | null>(null);
  const [expandedCountry, setExpandedCountry] = React.useState<string | null>(null);
  const [states, setStates] = React.useState<StateRow[]>([]);
  const [expandedState, setExpandedState] = React.useState<string | null>(null);
  const [districts, setDistricts] = React.useState<DistrictRow[]>([]);
  const [expandedDistrict, setExpandedDistrict] = React.useState<string | null>(null);
  const [cities, setCities] = React.useState<CityRow[]>([]);
  const [expandedCity, setExpandedCity] = React.useState<string | null>(null);
  const [departments, setDepartments] = React.useState<DepartmentListItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [dialog, setDialog] = React.useState<null | { kind: "STATE" | "DISTRICT" | "CITY"; parentId: string; parentName: string }>(null);
  const [newName, setNewName] = React.useState("");
  const [newCode, setNewCode] = React.useState("");
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const canManage = hasPermission(me, "org.manage");

  React.useEffect(() => {
    api.get<CountryRow[]>("/api/v1/geography/countries")
      .then((c) => {
        setCountries(c);
        if (c.length === 1) setExpandedCountry(c[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  React.useEffect(() => {
    if (!expandedCountry) return setStates([]);
    api.get<StateRow[]>(`/api/v1/geography/states?countryId=${expandedCountry}`).then(setStates).catch(() => setStates([]));
  }, [expandedCountry]);

  React.useEffect(() => {
    if (!expandedState) return setDistricts([]);
    api.get<DistrictRow[]>(`/api/v1/geography/states/${expandedState}/districts`).then(setDistricts).catch(() => setDistricts([]));
  }, [expandedState]);

  React.useEffect(() => {
    if (!expandedDistrict) return setCities([]);
    api.get<CityRow[]>(`/api/v1/geography/districts/${expandedDistrict}/cities`).then(setCities).catch(() => setCities([]));
  }, [expandedDistrict]);

  React.useEffect(() => {
    if (!expandedCity) return setDepartments(null);
    api.get<{ items: DepartmentListItem[] }>(`/api/v1/departments?cityId=${expandedCity}&pageSize=50`)
      .then((d) => setDepartments(d.items))
      .catch(() => setDepartments([]));
  }, [expandedCity]);

  async function createUnit() {
    if (!dialog) return;
    setSaving(true);
    setDialogError(null);
    try {
      if (dialog.kind === "STATE") {
        await api.post("/api/v1/geography/states", { countryId: dialog.parentId, name: newName, code: newCode });
        setStates([]);
        setExpandedState(null);
        api.get<StateRow[]>(`/api/v1/geography/states?countryId=${dialog.parentId}`).then(setStates).catch(() => undefined);
      } else if (dialog.kind === "DISTRICT") {
        await api.post(`/api/v1/geography/states/${dialog.parentId}/districts`, { name: newName, code: newCode });
        api.get<DistrictRow[]>(`/api/v1/geography/states/${dialog.parentId}/districts`).then(setDistricts).catch(() => undefined);
      } else {
        await api.post(`/api/v1/geography/districts/${dialog.parentId}/cities`, { name: newName, code: newCode });
        api.get<CityRow[]>(`/api/v1/geography/districts/${dialog.parentId}/cities`).then(setCities).catch(() => undefined);
      }
      setDialog(null);
      setNewName("");
      setNewCode("");
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : "Creation failed.");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!countries) return <LoadingState rows={3} />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
        <p className="text-sm text-muted-foreground">
          The geographic hierarchy that anchors every department on the platform.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="space-y-1">
            {countries.map((c) => (
              <div key={c.id}>
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => setExpandedCountry(expandedCountry === c.id ? null : c.id)}
                  aria-expanded={expandedCountry === c.id}
                >
                  <ChevronRight size={16} aria-hidden className={`transition-transform ${expandedCountry === c.id ? "rotate-90" : ""}`} />
                  <Globe2 size={16} aria-hidden /> {c.name}
                  <span className="ml-1 font-mono text-xs text-muted-foreground">({c.code})</span>
                </button>

                {expandedCountry === c.id && (
                  <div className="ml-6 space-y-1 border-l pl-3">
                    {states.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No states.</p>}
                    {states.map((s) => (
                      <div key={s.id}>
                        <div className="flex items-center gap-1">
                          <button
                            className="flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                            onClick={() => setExpandedState(expandedState === s.id ? null : s.id)}
                            aria-expanded={expandedState === s.id}
                          >
                            <ChevronRight size={14} aria-hidden className={`transition-transform ${expandedState === s.id ? "rotate-90" : ""}`} />
                            <Map size={14} aria-hidden /> {s.name}
                            <StatusBadge status={s.status} />
                          </button>
                          {canManage && (
                            <Button variant="ghost" size="sm" aria-label={`Add district to ${s.name}`} onClick={() => { setDialog({ kind: "DISTRICT", parentId: s.id, parentName: s.name }); setNewName(""); setNewCode(""); setDialogError(null); }}>
                              <Plus size={14} aria-hidden />
                            </Button>
                          )}
                        </div>

                        {expandedState === s.id && (
                          <div className="ml-6 space-y-1 border-l pl-3">
                            {districts.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No districts.</p>}
                            {districts.map((d) => (
                              <div key={d.id}>
                                <div className="flex items-center gap-1">
                                  <button
                                    className="flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                                    onClick={() => setExpandedDistrict(expandedDistrict === d.id ? null : d.id)}
                                    aria-expanded={expandedDistrict === d.id}
                                  >
                                    <ChevronRight size={14} aria-hidden className={`transition-transform ${expandedDistrict === d.id ? "rotate-90" : ""}`} />
                                    <MapPin size={14} aria-hidden /> {d.name}
                                    <StatusBadge status={d.status} />
                                  </button>
                                  {canManage && (
                                    <Button variant="ghost" size="sm" aria-label={`Add city to ${d.name}`} onClick={() => { setDialog({ kind: "CITY", parentId: d.id, parentName: d.name }); setNewName(""); setNewCode(""); setDialogError(null); }}>
                                      <Plus size={14} aria-hidden />
                                    </Button>
                                  )}
                                </div>

                                {expandedDistrict === d.id && (
                                  <div className="ml-6 space-y-1 border-l pl-3">
                                    {cities.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No cities.</p>}
                                    {cities.map((ct) => (
                                      <div key={ct.id}>
                                        <button
                                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                                          onClick={() => setExpandedCity(expandedCity === ct.id ? null : ct.id)}
                                          aria-expanded={expandedCity === ct.id}
                                        >
                                          <ChevronRight size={14} aria-hidden className={`transition-transform ${expandedCity === ct.id ? "rotate-90" : ""}`} />
                                          <Building size={14} aria-hidden /> {ct.name}
                                          <StatusBadge status={ct.status} />
                                        </button>

                                        {expandedCity === ct.id && (
                                          <div className="ml-6 space-y-1 border-l pl-3 pb-2">
                                            {departments === null && <p className="px-3 py-2 text-sm text-muted-foreground">Loading departments…</p>}
                                            {departments && departments.length === 0 && (
                                              <EmptyState title="No departments in this city" icon={<Building2 size={20} aria-hidden />} />
                                            )}
                                            {departments?.map((dp) => {
                                              const inner = (
                                                <div className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                                                  <Building2 size={14} aria-hidden /> {dp.name}
                                                  <TypeBadge type={dp.departmentType} />
                                                  <StatusBadge status={dp.status} />
                                                </div>
                                              );
                                              return onOpenDepartment ? (
                                                <button key={dp.id} className="w-full" onClick={() => onOpenDepartment(dp.id)}>
                                                  {inner}
                                                </button>
                                              ) : (
                                                <div key={dp.id}>{inner}</div>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    {canManage && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-3 mt-1"
                        onClick={() => { setDialog({ kind: "STATE", parentId: c.id, parentName: c.name }); setNewName(""); setNewCode(""); setDialogError(null); }}
                      >
                        <Plus size={14} aria-hidden /> Add state
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add {dialog?.kind.toLowerCase()}</DialogTitle>
            <DialogDescription>Under {dialog?.parentName}. Codes must be unique within their parent unit.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="geo-new-name">Name</Label>
              <Input id="geo-new-name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="geo-new-code">Code (1-6 letters/digits)</Label>
              <Input id="geo-new-code" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} maxLength={6} className="font-mono" />
            </div>
            {dialogError && <p className="text-sm text-destructive" role="alert">{dialogError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={saving}>Cancel</Button>
            <Button onClick={createUnit} disabled={saving || newName.trim().length < 2 || newCode.trim().length < 1}>
              {saving ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

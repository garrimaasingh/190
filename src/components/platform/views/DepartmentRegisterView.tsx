"use client";

import * as React from "react";
import { useAuth } from "@/lib/client/store";
import { api, ApiClientError } from "@/lib/client/api";
import { GeographicSelector, type GeoSelection } from "@/components/platform/GeographicSelector";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FieldError, GeographicBreadcrumb, StatusBadge } from "@/components/platform/common";
import { Upload, X, CheckCircle2 } from "lucide-react";

// ============================================================
// Department Registration (spec §9/§38).
// Cascading geo selector + logo upload preview + confirmation
// summary before submission. Server re-validates everything.
// ============================================================

export function DepartmentRegisterView({ onRegistered }: { onRegistered: (departmentId: string) => void }) {
  const { meta } = useAuth();
  const [name, setName] = React.useState("");
  const [departmentType, setDepartmentType] = React.useState<string | null>(null);
  const [geo, setGeo] = React.useState<GeoSelection>({});
  const [description, setDescription] = React.useState("");
  const [logo, setLogo] = React.useState<File | null>(null);
  const [logoPreview, setLogoPreview] = React.useState<string | null>(null);
  const [logoError, setLogoError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const [geoLabels, setGeoLabels] = React.useState<{ state?: string; district?: string; city?: string; country?: string }>({});

  React.useEffect(() => {
    (async () => {
      if (!geo.countryId) return setGeoLabels((p) => ({ ...p, country: undefined }));
      const countries = await api.get<{ id: string; name: string }[]>("/api/v1/geography/countries").catch(() => []);
      setGeoLabels((p) => ({ ...p, country: countries.find((c) => c.id === geo.countryId)?.name }));
    })();
  }, [geo.countryId]);

  React.useEffect(() => {
    (async () => {
      if (!geo.stateId) return setGeoLabels((p) => ({ ...p, state: undefined, district: undefined, city: undefined }));
      const states = await api.get<{ id: string; name: string }[]>(`/api/v1/geography/states?countryId=${geo.countryId}`).catch(() => []);
      setGeoLabels((p) => ({ ...p, state: states.find((s) => s.id === geo.stateId)?.name }));
    })();
  }, [geo.stateId, geo.countryId]);

  React.useEffect(() => {
    (async () => {
      if (!geo.districtId) return setGeoLabels((p) => ({ ...p, district: undefined, city: undefined }));
      const districts = await api.get<{ id: string; name: string }[]>(`/api/v1/geography/states/${geo.stateId}/districts`).catch(() => []);
      setGeoLabels((p) => ({ ...p, district: districts.find((d) => d.id === geo.districtId)?.name }));
    })();
  }, [geo.districtId, geo.stateId]);

  React.useEffect(() => {
    (async () => {
      if (!geo.cityId) return setGeoLabels((p) => ({ ...p, city: undefined }));
      const cities = await api.get<{ id: string; name: string }[]>(`/api/v1/geography/districts/${geo.districtId}/cities`).catch(() => []);
      setGeoLabels((p) => ({ ...p, city: cities.find((c) => c.id === geo.cityId)?.name }));
    })();
  }, [geo.cityId, geo.districtId]);

  function onPickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    setLogoError(null);
    const f = e.target.files?.[0] || null;
    if (!f) return setLogo(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) {
      setLogoError("Logo must be a PNG, JPEG or WebP image.");
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      setLogoError("Logo must be 2 MB or smaller.");
      return;
    }
    setLogo(f);
    setLogoPreview(URL.createObjectURL(f));
  }

  function clearLogo() {
    setLogo(null);
    setLogoPreview(null);
    setLogoError(null);
  }

  const ready = name.trim().length >= 2 && !!departmentType && !!geo.stateId && !!geo.districtId && !!geo.cityId;

  function submit() {
    setConfirmOpen(false);
    setSubmitting(true);
    setFormError(null);
    (async () => {
      try {
        const created = await api.post<{ id: string }>("/api/v1/departments", {
          name: name.trim(),
          departmentType,
          stateId: geo.stateId,
          districtId: geo.districtId,
          cityId: geo.cityId,
          description: description.trim() || undefined,
        });
        if (logo) {
          const form = new FormData();
          form.append("logo", logo);
          await api.upload(`/api/v1/departments/${created.id}/logo`, form).catch(() => undefined);
        }
        onRegistered(created.id);
      } catch (err) {
        if (err instanceof ApiClientError) setFormError(err.message);
        else setFormError("Registration failed. Please try again.");
      } finally {
        setSubmitting(false);
      }
    })();
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Register Department</h1>
        <p className="text-sm text-muted-foreground">
          Register a new department on the central platform. A stable department identifier is generated by the server.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Department details</CardTitle>
          <CardDescription>All fields marked required must be completed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dept-name">Department name *</Label>
              <Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Indore Police Department" maxLength={160} />
            </div>
            <div className="space-y-1.5">
              <Label>Department type *</Label>
              <Select value={departmentType || "__none__"} onValueChange={(v) => setDepartmentType(v === "__none__" ? null : v)}>
                <SelectTrigger aria-label="Select department type" className="w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {(meta?.departmentTypes || []).map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Geographic hierarchy *</Label>
            <GeographicSelector value={geo} onChange={setGeo} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dept-desc">Description</Label>
            <Textarea id="dept-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} placeholder="Purpose, jurisdiction and scope of the department" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="dept-logo">Department logo</Label>
            <div className="flex flex-wrap items-center gap-4">
              {logoPreview ? (
                <div className="relative">
                  <img src={logoPreview} alt="Selected logo preview" className="h-16 w-16 rounded-lg border object-contain" />
                  <button
                    type="button"
                    onClick={clearLogo}
                    aria-label="Remove selected logo"
                    className="absolute -right-2 -top-2 rounded-full bg-destructive p-1 text-white focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed text-muted-foreground" aria-hidden>
                  <Upload size={20} />
                </div>
              )}
              <div className="space-y-1">
                <Input id="dept-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={onPickLogo} className="max-w-xs" aria-describedby="logo-constraints" />
                <p id="logo-constraints" className="text-xs text-muted-foreground">PNG, JPEG or WebP · max 2 MB · 32–4096 px</p>
                <FieldError message={logoError || undefined} />
              </div>
            </div>
          </div>

          <FieldError message={formError || undefined} />

          <div className="flex justify-end">
            <Button
              disabled={!ready}
              onClick={() => {
                setFormError(null);
                setConfirmOpen(true);
              }}
            >
              Review &amp; submit
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Confirmation summary (spec §38) */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm department registration</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>Please verify the details before creating the department.</p>
                <ul className="ml-2 space-y-1 rounded-lg border p-3">
                  <li><span className="font-medium">Name:</span> {name}</li>
                  <li><span className="font-medium">Type:</span> {departmentType}</li>
                  <li>
                    <span className="font-medium">Location:</span>{" "}
                    <GeographicBreadcrumb country={geoLabels.country} state={geoLabels.state} district={geoLabels.district} city={geoLabels.city} className="inline-flex" />
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="font-medium">Initial status:</span> <StatusBadge status="PENDING" /> (activated after review)
                  </li>
                  {logo && <li><span className="font-medium">Logo:</span> {logo.name}</li>}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Back</AlertDialogCancel>
            <AlertDialogAction onClick={submit} disabled={submitting} className="gap-2">
              {submitting ? "Creating…" : <><CheckCircle2 size={16} aria-hidden /> Create department</>}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Re-export Dialog pieces used elsewhere
export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription };

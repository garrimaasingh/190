"use client";

import * as React from "react";
import { useAuth, hasPermission } from "@/lib/client/store";
import { api, ApiClientError, type DepartmentDetail } from "@/lib/client/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import {
  DepartmentLogo,
  StatusBadge,
  GeographicBreadcrumb,
  LoadingState,
  ErrorState,
  RoleBadge,
} from "@/components/platform/common";
import { Pencil, Upload, X, Building2, Users } from "lucide-react";

// ============================================================
// Department profile (spec §39): identity, geography, status,
// logo upload, edit — all actions gated by server permissions.
// ============================================================

export function DepartmentProfileView({ departmentId }: { departmentId?: string }) {
  const { me, reload } = useAuth();
  const [dept, setDept] = React.useState<DepartmentDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  // edit dialog
  const [editOpen, setEditOpen] = React.useState(false);
  const [editName, setEditName] = React.useState("");
  const [editDesc, setEditDesc] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // status change
  const [statusDialog, setStatusDialog] = React.useState<"ACTIVE" | "INACTIVE" | null>(null);

  const targetId = departmentId || me?.department?.id || "";

  const load = React.useCallback(() => {
    if (!targetId) return;
    setError(null);
    api
      .get<DepartmentDetail>(`/api/v1/departments/${targetId}`)
      .then(setDept)
      .catch((e) => setError(e?.message || "Failed to load department."));
  }, [targetId]);

  React.useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!dept) return <LoadingState rows={3} />;

  const canUpdate = hasPermission(me, "department.update");
  const canStatus = hasPermission(me, "department.status.update");
  const canLogo = hasPermission(me, "logo.update");

  async function saveEdit() {
    setSaving(true);
    setActionError(null);
    try {
      await api.patch(`/api/v1/departments/${dept!.id}`, { name: editName.trim(), description: editDesc });
      setEditOpen(false);
      load();
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : "Update failed.");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(status: string) {
    setStatusDialog(null);
    setActionError(null);
    try {
      await api.patch(`/api/v1/departments/${dept!.id}/status`, { status });
      load();
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : "Status change failed.");
    }
  }

  async function uploadLogo(file: File) {
    setActionError(null);
    const form = new FormData();
    form.append("logo", file);
    try {
      await api.upload(`/api/v1/departments/${dept!.id}/logo`, form);
      load();
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : "Logo upload failed.");
    }
  }

  async function removeLogo() {
    setActionError(null);
    try {
      await api.del(`/api/v1/departments/${dept!.id}/logo`);
      load();
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : "Logo removal failed.");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Department Profile</h1>
        <p className="text-sm text-muted-foreground">Organizational identity and geographic context.</p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-5 lg:flex-row">
            <div className="flex flex-col items-center gap-3">
              <DepartmentLogo logoPath={dept.logoPath} name={dept.name} size={96} />
              {canLogo && (
                <div className="flex flex-col items-center gap-1.5">
                  <label className="cursor-pointer text-xs font-medium text-primary underline-offset-4 hover:underline focus-within:outline-2 focus-within:outline-ring">
                    <Upload size={13} aria-hidden className="mr-1 inline" /> Change logo
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadLogo(f);
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>
                  {dept.logoPath && (
                    <button onClick={removeLogo} className="text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                      <X size={12} aria-hidden className="mr-1 inline" /> Remove
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">{dept.name}</h2>
                <StatusBadge status={dept.status} />
              </div>
              <p className="text-sm text-muted-foreground">
                {dept.departmentType} · Department ID <span className="font-mono">{dept.departmentCode}</span>
              </p>
              <GeographicBreadcrumb
                country={dept.geography.country}
                state={dept.geography.state}
                district={dept.geography.district}
                city={dept.geography.city}
              />
              {dept.description && <p className="text-sm">{dept.description}</p>}
              <div className="grid grid-cols-2 gap-3 pt-1 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Officers</p>
                  <p className="flex items-center gap-1.5 font-medium"><Users size={14} aria-hidden /> {dept.officerCount}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
                  <p className="font-medium">{new Date(dept.createdAt).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Administrators</p>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {dept.administrators.length === 0 && <span className="text-muted-foreground">None assigned</span>}
                    {dept.administrators.map((a) => (
                      <span key={a.id} className="flex items-center gap-1.5 text-xs">
                        <RoleBadge role={a.role} /> {a.name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {(canUpdate || canStatus) && (
                <div className="flex flex-wrap gap-2 pt-2">
                  {canUpdate && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditName(dept.name);
                        setEditDesc(dept.description || "");
                        setEditOpen(true);
                      }}
                    >
                      <Pencil size={14} aria-hidden /> Edit profile
                    </Button>
                  )}
                  {canStatus && dept.status !== "ACTIVE" && (
                    <Button variant="outline" size="sm" onClick={() => setStatusDialog("ACTIVE")}>
                      Activate
                    </Button>
                  )}
                  {canStatus && dept.status === "ACTIVE" && (
                    <Button variant="outline" size="sm" onClick={() => setStatusDialog("INACTIVE")}>
                      Deactivate
                    </Button>
                  )}
                </div>
              )}
              {actionError && (
                <p className="text-sm text-destructive" role="alert">{actionError}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 size={16} aria-hidden /> Organizational position
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Organizational hierarchy">
            {[
              { label: "India", icon: "🌍" },
              { label: dept.geography.state, icon: "🗺️" },
              { label: dept.geography.district, icon: "📍" },
              { label: dept.geography.city, icon: "🏙️" },
              { label: dept.name, icon: "🏛️" },
            ].map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                {i > 0 && <span aria-hidden className="text-muted-foreground">↓</span>}
                <span className="rounded-lg border bg-muted/40 px-3 py-1.5 font-medium">{s.label}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit department profile</DialogTitle>
            <DialogDescription>Display name and description. The department identifier never changes.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Department name</Label>
              <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={160} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-desc">Description</Label>
              <Textarea id="edit-desc" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={3} maxLength={2000} />
            </div>
            {actionError && <p className="text-sm text-destructive" role="alert">{actionError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={saveEdit} disabled={saving || editName.trim().length < 2}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Status confirmation */}
      <AlertDialog open={!!statusDialog} onOpenChange={(o) => !o && setStatusDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{statusDialog === "ACTIVE" ? "Activate department?" : "Deactivate department?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {statusDialog === "ACTIVE"
                ? "An ACTIVE department can register officers and operate normally on the platform."
                : "An INACTIVE department cannot be used for normal operations. Historical records are preserved."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => statusDialog && changeStatus(statusDialog)}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

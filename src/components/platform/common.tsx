"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldAlert, Building2, Inbox } from "lucide-react";
import { logoUrl } from "@/lib/client/api";

// ---------- Status / Role badges (accessible: text + color, never color alone) ----------

const STATUS_STYLES: Record<string, { cls: string; dot: string }> = {
  ACTIVE: { cls: "bg-emerald-100 text-emerald-900 border-emerald-300", dot: "bg-emerald-600" },
  INACTIVE: { cls: "bg-zinc-200 text-zinc-800 border-zinc-400", dot: "bg-zinc-500" },
  PENDING: { cls: "bg-amber-100 text-amber-900 border-amber-300", dot: "bg-amber-500" },
  SUSPENDED: { cls: "bg-orange-100 text-orange-900 border-orange-300", dot: "bg-orange-600" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.INACTIVE;
  return (
    <Badge variant="outline" className={`${s.cls} gap-1.5 font-medium`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {status}
    </Badge>
  );
}

const ROLE_STYLES: Record<string, string> = {
  SYSTEM_ADMIN: "bg-slate-900 text-white border-slate-900",
  DEPARTMENT_ADMIN: "bg-teal-100 text-teal-900 border-teal-300",
  OFFICER: "bg-sky-100 text-sky-900 border-sky-300",
  AUDITOR: "bg-violet-100 text-violet-900 border-violet-300",
};

export function RoleBadge({ role }: { role: string }) {
  return (
    <Badge variant="outline" className={`${ROLE_STYLES[role] || ""} font-medium`}>
      {role.replaceAll("_", " ")}
    </Badge>
  );
}

export function TypeBadge({ type }: { type: string }) {
  return <Badge variant="secondary" className="font-medium">{type}</Badge>;
}

// ---------- Department logo ----------

export function DepartmentLogo({
  logoPath,
  name,
  size = 40,
  className = "",
}: {
  logoPath: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const url = logoUrl(logoPath);
  if (!url || failed) {
    return (
      <div
        aria-label={`${name} logo placeholder`}
        className={`flex items-center justify-center rounded-lg border bg-muted text-muted-foreground ${className}`}
        style={{ width: size, height: size }}
      >
        <Building2 size={size * 0.5} aria-hidden />
      </div>
    );
  }
  return (
     
    <img
      src={url}
      alt={`${name} logo`}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={`rounded-lg border object-contain bg-white ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

// ---------- Geographic breadcrumb (India → State → District → City) ----------

export function GeographicBreadcrumb({
  country,
  state,
  district,
  city,
  className = "",
}: {
  country?: string | null;
  state?: string | null;
  district?: string | null;
  city?: string | null;
  className?: string;
}) {
  const parts = [country, state, district, city].filter(Boolean) as string[];
  if (parts.length === 0) return <span className="text-muted-foreground text-sm">No location</span>;
  return (
    <ol className={`flex flex-wrap items-center gap-1 text-sm text-muted-foreground ${className}`} aria-label="Geographic hierarchy">
      {parts.map((p, i) => (
        <li key={i} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden className="text-muted-foreground/60">→</span>}
          <span className={i === parts.length - 1 ? "font-medium text-foreground" : ""}>{p}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------- Async UI states ----------

export function LoadingState({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3 p-1" role="status" aria-live="polite" aria-label={label}>
      <Skeleton className="h-5 w-48" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-12 px-6 text-center">
      <div className="text-muted-foreground">{icon || <Inbox aria-hidden size={28} />}</div>
      <p className="font-medium">{title}</p>
      {description && <p className="text-sm text-muted-foreground max-w-sm">{description}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 py-10 px-6 text-center">
      <ShieldAlert aria-hidden className="text-destructive" size={28} />
      <p className="font-medium text-destructive">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="text-sm underline underline-offset-4 hover:text-foreground">
          Try again
        </button>
      )}
    </div>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}

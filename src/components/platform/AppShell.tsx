"use client";

import * as React from "react";
import { useAuth } from "@/lib/client/store";
import { DepartmentLogo, RoleBadge } from "@/components/platform/common";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LayoutDashboard, Network, Building2, Users, ScrollText, UserCircle, Settings as SettingsIcon, Menu, LogOut, ShieldCheck, FolderSearch, Boxes, Scale, FileCheck2, ShieldEllipsis } from "lucide-react";

// ============================================================
// AppShell (spec §20/§53): role-aware sidebar + topbar.
// Responsive: full sidebar on desktop, Sheet drawer on mobile.
// ============================================================

export type ViewKey =
  | "dashboard"
  | "cases"
  | "case-create"
  | "case-detail"
  | "case-document-upload"
  | "case-document-detail"
  | "case-document-view"
  | "case-evidence-register"
  | "case-evidence-detail"
  | "organization"
  | "departments"
  | "department-register"
  | "department-profile"
  | "officers"
  | "officer-detail"
  | "profile"
  | "settings"
  | "events"
  | "audit"
  | "audit-detail"
  | "audit-integrity"
  | "reports";

export interface NavItem {
  key: ViewKey;
  label: string;
  icon: React.ReactNode;
  roles: string[];
}

const NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "DEPARTMENT_ADMIN", "OFFICER", "AUDITOR"] },
  { key: "cases", label: "Cases", icon: <FolderSearch size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "DEPARTMENT_ADMIN", "OFFICER", "AUDITOR"] },
  { key: "organization", label: "Organization", icon: <Network size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "DEPARTMENT_ADMIN", "OFFICER"] },
  { key: "departments", label: "Departments", icon: <Building2 size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "AUDITOR"] },
  { key: "department-register", label: "Register Department", icon: <Building2 size={18} aria-hidden />, roles: ["SYSTEM_ADMIN"] },
  { key: "department-profile", label: "My Department", icon: <Building2 size={18} aria-hidden />, roles: ["DEPARTMENT_ADMIN", "OFFICER"] },
  { key: "officers", label: "Officers", icon: <Users size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "DEPARTMENT_ADMIN", "AUDITOR"] },
  { key: "events", label: "Identity Events", icon: <ScrollText size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "AUDITOR"] },
  { key: "audit", label: "Audit Log", icon: <Scale size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "AUDITOR"] },
  { key: "audit-integrity", label: "Audit Integrity", icon: <ShieldEllipsis size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "AUDITOR"] },
  { key: "reports", label: "Reports", icon: <FileCheck2 size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "AUDITOR", "DEPARTMENT_ADMIN"] },
  { key: "profile", label: "My Profile", icon: <UserCircle size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "DEPARTMENT_ADMIN", "OFFICER", "AUDITOR"] },
  { key: "settings", label: "Settings", icon: <SettingsIcon size={18} aria-hidden />, roles: ["SYSTEM_ADMIN", "DEPARTMENT_ADMIN", "OFFICER", "AUDITOR"] },
];

export function AppShell({
  view,
  onNavigate,
  children,
}: {
  view: ViewKey;
  onNavigate: (v: ViewKey) => void;
  children: React.ReactNode;
}) {
  const { me, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  if (!me) return null;
  const items = NAV.filter((n) => n.roles.includes(me.officer.role));
  const activeLabel = items.find((n) => n.key === view)?.label || "Dashboard";

  const navList = (
    <nav aria-label="Primary navigation" className="flex flex-col gap-1 px-3 py-4">
      {items.map((item) => {
        const active =
          item.key === view ||
          (view === "officer-detail" && item.key === "officers") ||
          ((view === "case-create" || view === "case-detail") && item.key === "cases");
        return (
          <button
            key={item.key}
            onClick={() => {
              onNavigate(item.key);
              setMobileOpen(false);
            }}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex h-14 items-center gap-3 px-4">
          {/* mobile drawer */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation menu">
                <Menu aria-hidden size={20} />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="px-4 pt-4 text-sm text-muted-foreground">Navigation</SheetTitle>
              {navList}
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 items-center gap-2.5">
            <DepartmentLogo logoPath={me.department?.logoPath} name={me.department?.name || "Platform"} size={32} />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold">{me.department?.name || "Central Platform"}</p>
              <p className="truncate text-xs text-muted-foreground">{me.officer.designation}</p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:block">
              <RoleBadge role={me.officer.role} />
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2" aria-label="User menu">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden>
                    {me.officer.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                  </span>
                  <span className="hidden text-sm font-medium sm:inline">{me.officer.name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>
                  <p className="text-sm font-semibold">{me.officer.name}</p>
                  <p className="text-xs font-normal text-muted-foreground">{me.officer.officerId} · {me.officer.email}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onNavigate("profile")}>
                  <UserCircle size={16} aria-hidden /> Profile
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onNavigate("settings")}>
                  <SettingsIcon size={16} aria-hidden /> Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={async () => {
                    await logout();
                  }}
                >
                  <LogOut size={16} aria-hidden /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Desktop sidebar */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 border-r bg-muted/30 md:block">
          <div className="flex items-center gap-2 px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ShieldCheck size={14} aria-hidden /> {activeLabel ? "Platform" : ""}
          </div>
          {navList}
        </aside>

        {/* Main */}
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>

      <footer className="border-t py-3 text-center text-xs text-muted-foreground">
        Central Justice Platform · Phase 2 — Case Management &amp; Custody
      </footer>
    </div>
  );
}

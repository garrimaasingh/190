"use client";

import * as React from "react";
import { api, type IdentityEventRow } from "@/lib/client/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState, ErrorState, EmptyState } from "@/components/platform/common";
import { ChevronLeft, ChevronRight } from "lucide-react";

// ============================================================
// Identity event ledger (spec §45) — read-only.
// Structured events feed the Phase 4 immutable audit system.
// ============================================================

export function EventsView() {
  const [rows, setRows] = React.useState<IdentityEventRow[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);
  const pageSize = 15;

  const load = React.useCallback(() => {
    setError(null);
    api
      .get<{ items: IdentityEventRow[]; total: number }>(`/api/v1/admin/events?page=${page}&pageSize=${pageSize}`)
      .then((d) => {
        setRows(d.items);
        setTotal(d.total);
      })
      .catch((e) => setError(e?.message || "Failed to load events."));
  }, [page]);

  React.useEffect(load, [load]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Identity Events</h1>
        <p className="text-sm text-muted-foreground">
          Structured, audit-ready identity events. This ledger will be connected to the immutable audit system in Phase 4.
        </p>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !rows && <LoadingState rows={5} />}
      {!error && rows && rows.length === 0 && <EmptyState title="No events recorded yet" />}

      {!error && rows && rows.length > 0 && (
        <>
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead className="hidden md:table-cell">Actor</TableHead>
                      <TableHead className="hidden lg:table-cell">Target</TableHead>
                      <TableHead className="hidden md:table-cell">Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {new Date(e.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-medium">{e.eventType}</TableCell>
                        <TableCell className="hidden text-xs md:table-cell">
                          {e.actorIdentifier || e.actorOfficerId || "—"}
                        </TableCell>
                        <TableCell className="hidden text-xs lg:table-cell">
                          {e.targetType ? `${e.targetType}` : "—"}
                        </TableCell>
                        <TableCell className="hidden max-w-72 truncate text-xs text-muted-foreground md:table-cell">
                          {e.metadata ? JSON.stringify(e.metadata) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {total} events · page {page} of {Math.max(1, Math.ceil(total / pageSize))}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft size={16} aria-hidden /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= Math.max(1, Math.ceil(total / pageSize))}
                onClick={() => setPage((p) => p + 1)}
                aria-label="Next page"
              >
                Next <ChevronRight size={16} aria-hidden />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

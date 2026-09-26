// ============================================================
// Phase 9 — conflict resolution vocabulary (§36/§37).
// Kept in its own module to avoid circular imports between the
// import service and route handlers.
// ============================================================

export const CONFLICT_RESOLUTIONS = ["ACCEPT_INCOMING", "KEEP_CENTRAL", "MERGE", "REJECT_RECORD"] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { DocumentEventType, CaseEventType } from "@/lib/constants";

// ============================================================
// Document event interface (spec §32/§33/§51/§52).
//
// Every document action writes a DocumentEvent (document-scoped
// audit stream); lifecycle milestones ALSO flow into the case
// timeline via recordCaseEvent so the Phase 2 case view stays the
// single activity surface. Event metadata never contains document
// contents, keys or tokens.
//
// Phase 4 can replace the sink with the immutable audit ledger —
// this call signature is the stable interface.
// ============================================================

type DbOrTx = Prisma.TransactionClient | typeof db;

export interface DocumentEventInput {
  eventType: DocumentEventType;
  /** Internal Case.id */
  caseId: string;
  documentId?: string | null; // internal CaseDocument.id
  actorOfficerId?: string | null;
  actorIdentifier?: string | null;
  departmentId?: string | null;
  sessionId?: string | null;
  result?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Mirror into the case timeline under this (case-level) event type. */
  caseEventType?: CaseEventType | null;
  caseDescription?: string | null;
}

export async function recordDocumentEvent(input: DocumentEventInput, client: DbOrTx = db): Promise<void> {
  const data = {
    eventType: input.eventType,
    caseId: input.caseId,
    documentId: input.documentId ?? null,
    actorOfficerId: input.actorOfficerId ?? null,
    departmentId: input.departmentId ?? null,
    sessionId: input.sessionId ?? null,
    result: input.result ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  };
  try {
    if (client !== db) {
      await client.documentEvent.create({ data });
    } else {
      await db.documentEvent.create({ data });
    }
  } catch (err) {
    console.error("[document-event] failed to record", input.eventType, err);
  }

  if (input.caseEventType) {
    const { recordCaseEvent } = await import("@/lib/cases/events");
    await recordCaseEvent(
      {
        eventType: input.caseEventType,
        caseId: input.caseId,
        actorOfficerId: input.actorOfficerId ?? null,
        actorIdentifier: input.actorIdentifier ?? null,
        departmentId: input.departmentId ?? null,
        targetType: "DOCUMENT",
        targetId: input.metadata?.documentId ? String(input.metadata.documentId) : null,
        description: input.caseDescription ?? input.eventType,
        metadata: input.metadata ?? null,
      },
      client
    );
  }
}

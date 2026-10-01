import * as admin from "firebase-admin";

const db = admin.firestore();

export interface AuditActor {
  uid: string;
  name: string;
  role: string;
}

/** Build an append-only audit log record (id filled by caller context). */
export function auditDoc(
  action: string,
  entity: string,
  entityId: string,
  actor: AuditActor,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason?: string
) {
  return {
    id: "",
    ts: new Date().toISOString(),
    actorUid: actor.uid,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    entity,
    entityId,
    before,
    after,
    reason: reason ?? null,
    ip: null,
  };
}

/**
 * Append an audit log record. Configurable to run inside an existing
 * transaction (tx) for atomicity with the state change it describes, or
 * standalone — same pattern as movement.ts's recordMovement(). Returns the
 * generated doc id.
 */
export async function writeAudit(
  action: string,
  entity: string,
  entityId: string,
  actor: AuditActor,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason?: string,
  tx?: admin.firestore.Transaction
): Promise<string> {
  const ref = db.collection("auditLogs").doc();
  const data = { ...auditDoc(action, entity, entityId, actor, before, after, reason), id: ref.id };
  if (tx) {
    tx.set(ref, data);
  } else {
    await ref.set(data);
  }
  return ref.id;
}
import type { Prisma } from "@prisma/client";

export type AuditInput = {
  userId?: string;
  substitutedForUserId?: string;
  entityType: string;
  entityId?: string;
  action: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  recordVersion?: number;
  statusBefore?: string;
  statusAfter?: string;
};

/** Audyt zawsze w transakcji zmiany: zmiana bez śladu albo ślad bez zmiany nie mogą powstać. */
export async function writeAuditInTransaction(tx: Prisma.TransactionClient, input: AuditInput) {
  await tx.auditLog.create({
    data: {
      userId: input.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      beforeJson: input.before ? JSON.stringify(input.before) : undefined,
      afterJson: input.after ? JSON.stringify(input.after) : undefined,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent
    }
  });
  await tx.auditEvent.create({
    data: {
      actorUserId: input.userId,
      substitutedForUserId: input.substitutedForUserId,
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.action,
      correlationId: input.correlationId ?? "system",
      recordVersion: input.recordVersion,
      statusBefore: input.statusBefore,
      statusAfter: input.statusAfter,
      payloadJson: input.after ? JSON.stringify(input.after) : undefined,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent
    }
  });
}

/** Pola audytu pochodzące z żądania. */
export function requestAuditContext(req: { correlationId: string; ip?: string; headers: { "user-agent"?: string } }) {
  return { correlationId: req.correlationId, ipAddress: req.ip, userAgent: req.headers["user-agent"]?.slice(0, 300) };
}

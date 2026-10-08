import { AuditLog } from '../models/auditLog.model.js';
import { logger } from '../infra/logger.js';

// Field names that must never be written to the audit log, whatever a caller passes in.
const NEVER_AUDIT = ['password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'secret'];

function withoutSecrets(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !NEVER_AUDIT.includes(key)));
}

/**
 * The one way an audit entry is written.
 * A failure to write the audit entry is logged loudly but does not undo the action itself.
 *
 * @param {{ actor?: { _id: unknown } | null, action: string, entityType: string, entityId: unknown,
 *           oldValue?: object, newValue?: object, requestId?: string }} entry
 */
export async function writeAudit({
  actor,
  action,
  entityType,
  entityId,
  oldValue,
  newValue,
  requestId,
}) {
  try {
    await AuditLog.create({
      userId: actor?._id ?? null,
      action,
      entityType,
      entityId,
      oldValue: withoutSecrets(oldValue),
      newValue: withoutSecrets(newValue),
      requestId,
    });
  } catch (error) {
    logger.error({ err: error, action, entityType }, 'Audit entry could not be written');
  }
}

/**
 * The fields that differ between two plain objects, as { oldValue, newValue }.
 * Only keys present in `after` are compared (those are the ones the request tried to change).
 */
export function diffFields(before, after) {
  const oldValue = {};
  const newValue = {};
  for (const [key, value] of Object.entries(after)) {
    if (String(before?.[key] ?? '') !== String(value ?? '')) {
      oldValue[key] = before?.[key] ?? null;
      newValue[key] = value ?? null;
    }
  }
  return { oldValue, newValue, changed: Object.keys(newValue).length > 0 };
}

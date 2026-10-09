import mongoose from 'mongoose';

// Who changed what, and when (Master Prompt Section 54). Append-only: rows are never edited or
// deleted by the application. Schema only: no methods (decision 0005).

const auditLogSchema = new mongoose.Schema(
  {
    // Null for actions taken by the system itself (for example the seed script).
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // What happened, e.g. "user.created", "user.password_reset".
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Only the fields that changed. Secrets (passwords, tokens) are never written here.
    oldValue: { type: mongoose.Schema.Types.Mixed },
    newValue: { type: mongoose.Schema.Types.Mixed },
    requestId: { type: String },
    at: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false },
);

auditLogSchema.index({ entityType: 1, entityId: 1, at: -1 });
auditLogSchema.index({ userId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });
// The Audit log screen without filters: newest first, and by date range.
auditLogSchema.index({ at: -1 });

export const AuditLog =
  mongoose.models.AuditLog ?? mongoose.model('AuditLog', auditLogSchema, 'audit_logs');

import mongoose from 'mongoose';

// One CSV import, from the uploaded file to its result, and the saved column mappings.
// Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

// What a file can hold. A row is one company, optionally with one person at it.
// (Leads are added to this list with the pipeline.)
export const IMPORT_TARGETS = ['accounts'];
// What happens with a row whose company is in the CRM already.
export const DUPLICATE_MODES = ['skip', 'update', 'create'];
export const IMPORT_STATUSES = [
  'uploaded', // the file is stored; columns are not chosen yet
  'mapped', // columns chosen and checked (preview); nothing saved yet
  'queued', // waiting for the background worker
  'running',
  'completed',
  'failed', // stopped by a problem that is not about one row (the file is gone, …)
  'undoing',
  'undone',
];

// Which column of the file fills which field. `column` is the column's heading.
const mappingSchema = new mongoose.Schema(
  { column: { type: String, required: true }, field: { type: String, required: true } },
  { _id: false },
);

const importSchema = new mongoose.Schema(
  {
    targetType: { type: String, enum: IMPORT_TARGETS, required: true },
    fileName: { type: String, required: true },
    fileSize: { type: Number, required: true },
    // The S3 address of the uploaded file (private bucket).
    fileUrl: { type: String, required: true },
    // The file's column headings, made unique, and its first rows (shown on the mapping screen).
    headers: { type: [String], required: true },
    sampleRows: { type: [[String]], default: [] },
    rowCount: { type: Number, required: true },

    mapping: { type: [mappingSchema], default: [] },
    mappingTemplateId: { type: ObjectId, ref: 'ImportMappingTemplate' },
    duplicateMode: { type: String, enum: DUPLICATE_MODES, default: 'skip' },
    status: { type: String, enum: IMPORT_STATUSES, default: 'uploaded' },

    // Rows done so far (the run continues from here after a restart) and what became of them.
    processedRows: { type: Number, default: 0 },
    counts: {
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    // Why each failed row failed. `row` counts data rows from 1 (the heading row is not counted).
    rowErrors: {
      type: [{ _id: false, row: Number, message: String }],
      default: [],
      select: false,
    },
    // The S3 address of the CSV with the failed rows and their reasons.
    errorFileUrl: { type: String },
    // Set when the whole run stopped (status "failed").
    failureReason: { type: String },
    // What the undo removed, and what it had to keep.
    undo: {
      accountsRemoved: { type: Number },
      contactsRemoved: { type: Number },
      kept: { type: Number },
    },

    createdBy: { type: ObjectId, ref: 'User', required: true },
    undoneBy: { type: ObjectId, ref: 'User' },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    undoneAt: { type: Date },
    // Renewed while a worker is on this import; a stale time means the worker died.
    heartbeatAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

importSchema.index({ createdBy: 1, createdAt: -1 });
importSchema.index({ status: 1 });

export const Import = mongoose.models.Import ?? mongoose.model('Import', importSchema);

// A saved mapping, reused for files of the same shape.
const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // The name in lowercase: "Expo list" and "expo list" are the same template.
    nameKey: { type: String, required: true },
    targetType: { type: String, enum: IMPORT_TARGETS, required: true },
    mapping: { type: [mappingSchema], required: true },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

templateSchema.index({ targetType: 1, nameKey: 1 }, { unique: true });

export const ImportMappingTemplate =
  mongoose.models.ImportMappingTemplate ??
  mongoose.model('ImportMappingTemplate', templateSchema, 'import_mapping_templates');

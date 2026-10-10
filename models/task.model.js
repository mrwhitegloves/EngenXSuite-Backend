import mongoose from 'mongoose';

// The one task system (Master Prompt Section 33): tasks, follow-ups and reminders of everyone.
// Later also used by the AI, automation and the website module.
// Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const TASK_TYPES = ['task', 'follow_up', 'reminder', 'call', 'meeting'];
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'];
export const TASK_PRIORITIES = ['low', 'medium', 'high'];
export const TASK_SOURCES = ['manual', 'ai', 'automation', 'seo', 'lead', 'voice', 'system'];

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    type: { type: String, enum: TASK_TYPES, required: true, default: 'task' },
    status: { type: String, enum: TASK_STATUSES, required: true, default: 'open' },
    priority: { type: String, enum: TASK_PRIORITIES, required: true, default: 'medium' },
    // Who has to do it, and who asked for it.
    assigneeId: { type: ObjectId, ref: 'User', required: true },
    createdBy: { type: ObjectId, ref: 'User' },
    dueAt: { type: Date },
    // When to remind the assignee; a scheduled job sends the reminder.
    remindAt: { type: Date },
    completedAt: { type: Date },
    // What the task is about (all optional).
    accountId: { type: ObjectId, ref: 'Account' },
    contactId: { type: ObjectId, ref: 'Contact' },
    plantId: { type: ObjectId, ref: 'Plant' },
    opportunityId: { type: ObjectId, ref: 'Opportunity' },
    source: { type: String, enum: TASK_SOURCES, required: true, default: 'manual' },
    // The record that asked for this task (an AI recommendation, a call summary …):
    // the name of its collection and its id.
    sourceRef: {
      type: new mongoose.Schema({ from: { type: String }, id: { type: ObjectId } }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true, versionKey: false },
);

taskSchema.index({ assigneeId: 1, status: 1, dueAt: 1 });
taskSchema.index({ createdBy: 1 });
taskSchema.index({ opportunityId: 1 });
taskSchema.index({ accountId: 1 });
taskSchema.index({ status: 1, remindAt: 1 });
taskSchema.index({ source: 1 });
// One source record creates only one task.
taskSchema.index(
  { 'sourceRef.from': 1, 'sourceRef.id': 1 },
  { unique: true, partialFilterExpression: { 'sourceRef.id': { $exists: true } } },
);

export const Task = mongoose.models.Task ?? mongoose.model('Task', taskSchema);

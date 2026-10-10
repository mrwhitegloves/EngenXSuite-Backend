import mongoose from 'mongoose';

// What a person is told by the system ("a task was given to you", "a task is overdue").
// Written only by notify() in services/notifications.service.js. The history is kept.
// Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

// Every kind of notification, with the words the preferences screen shows for it.
// A new kind is added here and nowhere else.
export const NOTIFICATION_TYPES = {
  task_assigned: 'A task is given to me',
  task_reminder: 'A task of mine is due soon',
  task_overdue: 'A task of mine is overdue',
  lead_assigned: 'A lead is given to me',
  lead_received: 'A new lead comes in for me (Meta ads, website)',
  call_missed: 'I missed a call',
};
export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES);

const notificationSchema = new mongoose.Schema(
  {
    // Who it is for.
    userId: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPE_KEYS, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, trim: true, maxlength: 500 },
    // Where a click takes the person: a path inside the app, for example "/pipeline/<id>".
    link: { type: String, maxlength: 300 },
    // The same thing is told once: a second notify() with the same key for the same person
    // does nothing. Writers that may run twice (jobs) always pass one.
    dedupeKey: { type: String, maxlength: 200 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index(
  { userId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $exists: true } } },
);

export const Notification =
  mongoose.models.Notification ?? mongoose.model('Notification', notificationSchema);

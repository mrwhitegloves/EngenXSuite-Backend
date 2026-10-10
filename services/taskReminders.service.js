import { Task } from '../models/task.model.js';
import { notify } from './notifications.service.js';

// Reminders for tasks. A background job calls runTaskReminders() every minute.
//
//   reminder : once, at the task's own reminder time, or 30 minutes before it is due when no
//              reminder time was set
//   overdue  : once, when the due time has passed and the task is still open
//
// Safe to run twice and safe to run late: a task that was told about is marked, and notify()
// refuses to tell the same thing a second time. After the server was down, the next run sends
// what was missed.

const OPEN_STATUSES = ['open', 'in_progress'];
export const DEFAULT_REMIND_BEFORE_MS = 30 * 60 * 1000;
// One run handles at most this many tasks of each kind; the rest follow a minute later.
const BATCH = 200;

const linkOf = (task) => (task.opportunityId ? `/pipeline/${task.opportunityId}` : '/activities');
const timeOf = (date) =>
  new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(date);

/** @param {Date} [now]  Only tests pass it */
export async function runTaskReminders(now = new Date()) {
  const open = { status: { $in: OPEN_STATUSES } };

  // Due soon: not yet reminded, and not yet overdue (an overdue task gets the other message).
  const soon = new Date(now.getTime() + DEFAULT_REMIND_BEFORE_MS);
  const toRemind = await Task.find({
    ...open,
    reminderSentAt: null,
    $or: [
      { remindAt: { $lte: now }, $or: [{ dueAt: null }, { dueAt: { $gt: now } }] },
      { remindAt: null, dueAt: { $gt: now, $lte: soon } },
    ],
  })
    .limit(BATCH)
    .lean();
  for (const task of toRemind) {
    await notify({
      userId: task.assigneeId,
      type: 'task_reminder',
      title: `Reminder: ${task.title}`,
      body: task.dueAt ? `Due ${timeOf(task.dueAt)}` : undefined,
      link: linkOf(task),
      dedupeKey: `task-reminder:${task._id}:${+(task.remindAt ?? task.dueAt)}`,
    });
    await Task.updateOne(
      { _id: task._id },
      { $set: { reminderSentAt: now } },
      { timestamps: false },
    );
  }

  const overdue = await Task.find({ ...open, overdueNotifiedAt: null, dueAt: { $lte: now } })
    .limit(BATCH)
    .lean();
  for (const task of overdue) {
    await notify({
      userId: task.assigneeId,
      type: 'task_overdue',
      title: `Overdue: ${task.title}`,
      body: `Was due ${timeOf(task.dueAt)}`,
      link: linkOf(task),
      dedupeKey: `task-overdue:${task._id}:${+task.dueAt}`,
    });
    await Task.updateOne(
      { _id: task._id },
      { $set: { overdueNotifiedAt: now } },
      { timestamps: false },
    );
  }
  return { reminded: toRemind.length, overdue: overdue.length };
}

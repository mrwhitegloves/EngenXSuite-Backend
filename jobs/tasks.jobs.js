import { runTaskReminders } from '../services/taskReminders.service.js';

/**
 * Every minute: remind people of tasks that are due soon, and tell them about overdue ones.
 * Safe to run twice: a task is marked once it was told about, and the same notification is
 * never created a second time.
 */
export function runTaskRemindersJob() {
  return runTaskReminders();
}

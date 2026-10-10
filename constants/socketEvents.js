// Names of the live "something changed" events sent to browsers (Socket.IO).
// An event never carries record data: the browser reacts by asking the REST API again, which
// applies the permission checks. The client keeps its own copy of these names
// (client/src/config/realtimeEvents.js), because the two projects share no code.

export const SOCKET_EVENTS = {
  // Sent to one user: their own account changed (name, picture, account type, …).
  meChanged: 'me.changed',
  // The list of users changed.
  usersChanged: 'users.changed',
  // An account type or its permissions changed: everyone's menu and rights may differ now.
  permissionsChanged: 'permissions.changed',
  // An account (customer company) was added, changed or deleted.
  accountsChanged: 'accounts.changed',
  // A contact (a person at a customer company) was added, changed or deleted.
  contactsChanged: 'contacts.changed',
  // A plant or one of its machines was added, changed or deleted.
  plantsChanged: 'plants.changed',
  // A lead was added, changed, moved to another stage, reassigned or deleted.
  opportunitiesChanged: 'opportunities.changed',
  // A timeline entry was added, changed or removed (a note, a stage change, a task event …).
  activitiesChanged: 'activities.changed',
  // Sent to one user: their notifications changed (a new one, or some were read).
  notificationsChanged: 'notifications.changed',
  // A task was added, changed, completed or deleted.
  tasksChanged: 'tasks.changed',
  // A tag was added, renamed, merged or deleted.
  tagsChanged: 'tags.changed',
  // Sent to one user: an import of theirs moved on (progress, finished, undone).
  importsChanged: 'imports.changed',
  // A status list managed in Settings changed (account statuses, lead statuses).
  statusListsChanged: 'status-lists.changed',
  // The product name or company name changed.
  brandingChanged: 'branding.changed',
};

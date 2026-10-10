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
  // A tag was added, renamed, merged or deleted.
  tagsChanged: 'tags.changed',
  // A status list managed in Settings changed (account statuses, lead statuses).
  statusListsChanged: 'status-lists.changed',
  // The product name or company name changed.
  brandingChanged: 'branding.changed',
};

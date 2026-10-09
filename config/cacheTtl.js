// Every cache lifetime in one place, in seconds (Master Prompt Section 75).
// Every cached value MUST have a lifetime: Redis runs with "noeviction", so nothing is ever
// thrown out to make room; entries leave only when their time is up or when code deletes them.
export const CACHE_TTL = {
  // Product and company name. Changes rarely; also deleted the moment it is edited.
  branding: 300,
};

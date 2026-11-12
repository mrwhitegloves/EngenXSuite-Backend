// The Document generator (founder, 2026-11-12): proposals, letter heads and invoices are filled
// in from a template on the screen, previewed live and saved here. One kind = one permission
// feature. The templates themselves (layout, fields, default text) live in the client; the
// server stores the filled-in values and checks who may see and change them.

export const GENERATED_KINDS = {
  proposal: { feature: 'proposals', label: 'Proposal' },
  letterhead: { feature: 'documents', label: 'Letter head' },
  invoice: { feature: 'invoices', label: 'Invoice' },
};

export const GENERATED_KIND_KEYS = Object.keys(GENERATED_KINDS);

// The filled-in values of one document, as JSON, at most this size. A long proposal is about
// 20 KB; the limit keeps a mistake (a pasted picture) from filling the database.
export const MAX_DOCUMENT_DATA_BYTES = 300 * 1024;

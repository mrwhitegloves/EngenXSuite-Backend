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

// Reference numbers that are suggested by themselves (founder, 2026-11-13), e.g.
// "ENGENX-DMA-2026-101": prefix, the year in India, then a running number that starts again at
// `first` every year. The screen fills in the next free one; the person may still change it.
export const REF_SERIES = {
  proposal: { prefix: 'ENGENX-DMA', first: 101 },
};

// The filled-in values of one document, as JSON, at most this size. A long proposal is about
// 20 KB; the limit keeps a mistake (a pasted picture) from filling the database.
export const MAX_DOCUMENT_DATA_BYTES = 300 * 1024;

// One-click PDF: the screen sends the finished page (styles and pictures inside it).
export const GENERATOR_PDF_PATH = '/api/generator/pdf';
export const MAX_PDF_HTML_BYTES = 8 * 1024 * 1024;

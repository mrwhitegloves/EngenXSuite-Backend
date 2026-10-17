// The laid-out (HTML) form of a mail the team writes in the CRM. The screen already cleans what
// is pasted (client: DOMPurify, only simple tags, no colours or fonts); this is the second check
// on the server, before the mail goes out: anything that could run or load something is taken
// out. A mail's HTML is shown in the CRM only inside a closed frame (HtmlBody.jsx) in any case.

const MAX_HTML = 300_000;

// Elements that are dropped with everything inside them.
const DROPPED_WITH_CONTENT = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'frame',
  'frameset',
  'noscript',
  'template',
  'svg',
  'math',
  'form',
  'textarea',
  'select',
  'button',
];
// Elements that are dropped, their inside kept.
const DROPPED_TAGS = ['link', 'meta', 'base', 'input', 'html', 'head', 'body', 'title'];

/**
 * @param {string | undefined} html
 * @returns {string | undefined}  Safe to send; undefined when nothing is left
 */
export function cleanMailHtml(html) {
  if (!html) return undefined;
  let out = String(html).slice(0, MAX_HTML);
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROPPED_WITH_CONTENT) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  for (const tag of DROPPED_TAGS) {
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }
  // Event handlers (onclick=…) and addresses that run code or embed data.
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(
    /\s+(href|src|action|formaction|background|xlink:href)\s*=\s*("\s*(?:javascript|vbscript|data):[^"]*"|'\s*(?:javascript|vbscript|data):[^']*'|(?:javascript|vbscript|data):[^\s>]*)/gi,
    '',
  );
  out = out.trim();
  return out.replace(/<[^>]*>|&nbsp;|\s/g, '') ? out : undefined;
}

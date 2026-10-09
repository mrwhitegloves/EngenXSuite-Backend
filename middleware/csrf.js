import { env } from '../config/env.js';
import { createAppError } from '../lib/errors.js';

// Protection against cross-site request forgery (CSRF): another website making the browser of a
// signed-in user send a changing request (POST, PATCH, DELETE) to this API with the user's cookie.
//
// How it works, without tokens: a browser itself tells the server where a request comes from,
// in two headers that a web page cannot set or fake:
//   Sec-Fetch-Site  "same-origin" when our own pages made the request
//   Origin          the address of the page that made the request
// A changing request is refused when these say it came from somewhere else.
// A request with neither header does not come from a browser page (a provider's webhook, a
// script, a test); such a caller has no user cookie to abuse, so it is let through to the normal
// sign-in and signature checks.
//
// This comes on top of the SameSite=Lax session cookie (middleware/session.js).

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * @param {{ allowedOrigins?: string[] }} [options]  Addresses of our own client. Default: APP_URL
 */
export function createCsrfProtection({ allowedOrigins = [env.APP_URL] } = {}) {
  const allowed = allowedOrigins.map(originOf).filter(Boolean);

  return function csrfProtection(req, res, next) {
    if (SAFE_METHODS.includes(req.method)) return next();

    const site = req.get('sec-fetch-site');
    const origin = req.get('origin');

    // "same-origin": our own page. "none": the user started it directly, not a web page.
    if (site === 'same-origin' || site === 'none') return next();
    // Not a browser page at all.
    if (!site && !origin) return next();

    // Otherwise the page's address must be our client, or the address this API is reached at.
    // ("same-site" is not enough: another site on a sister sub-domain is still another site.)
    const requestOrigin = originOf(origin);
    const ownOrigin = `${req.protocol}://${req.get('host')}`;
    if (requestOrigin && (allowed.includes(requestOrigin) || requestOrigin === ownOrigin)) {
      return next();
    }

    req.log?.warn({ origin, site, path: req.path }, 'Cross-site request blocked');
    return next(
      createAppError(
        'CROSS_SITE_REQUEST',
        403,
        'This request came from another website and was blocked.',
      ),
    );
  };
}

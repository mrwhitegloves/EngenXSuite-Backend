// Meta's reasons for a WhatsApp message that did not go out, in plain words with what to do.
// Meta sends a number (its error code) and a short English text; the team needs to know what
// it means for them. Codes: Meta's "WhatsApp Cloud API error codes" page.

const REASONS = {
  131042:
    'The WhatsApp account has a payment problem: add or fix the card in Meta Business Settings → Billing (WhatsApp account), then send again.',
  131049:
    'Meta held back this marketing message to protect the customer from too many business messages. Do not send it again now: try a Utility template, or wait until the customer writes to us (then any message can be sent for 24 hours).',
  131047:
    'More than 24 hours have passed since the customer last wrote. Only an approved template can be sent now.',
  131026:
    'The message could not reach this number: it may not use WhatsApp, may have an old app, or may have blocked us.',
  131050: 'The customer has stopped marketing messages from us on WhatsApp.',
  131051: 'WhatsApp does not support this kind of message.',
  131052: 'The customer’s file could not be fetched from WhatsApp.',
  131053: 'The file could not be uploaded to WhatsApp: check its type and size.',
  131056: 'Too many messages to this number in a short time. Wait a little before sending again.',
  130429: 'WhatsApp’s sending limit was reached for a moment. Try again in a minute.',
  131048:
    'Meta limited sending from our number because of its quality (people blocked or reported it). Send fewer marketing messages for a while.',
  132000: 'The template’s variables do not match: fill every variable of the template.',
  132001: 'This template does not exist in that language, or is not approved yet.',
  132005: 'The filled-in template is too long.',
  132007: 'Meta found something in the filled-in text that breaks its rules.',
  132012: 'A variable of the template has the wrong format.',
  132015: 'This template is paused by Meta because of low quality.',
  132016: 'This template is switched off by Meta because of low quality.',
  133010: 'The business number is not registered with WhatsApp yet.',
  368: 'Meta has temporarily blocked our account for breaking its rules.',
};

/**
 * What to show for a message that failed.
 * @param {string | number | undefined} code  Meta's error code
 * @param {string | undefined} text  Meta's own words (shown when the code is not known)
 * @returns {string | null}
 */
export function explainWhatsAppError(code, text) {
  const reason = code ? REASONS[Number(code)] : undefined;
  if (reason) return `${reason} (Meta code ${code})`;
  if (!text && !code) return null;
  return code ? `${text ?? 'Not delivered'} (Meta code ${code})` : (text ?? null);
}

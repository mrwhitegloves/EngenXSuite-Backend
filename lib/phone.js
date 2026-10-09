// Phone numbers are stored in one form, the international one (+919876543210), however they were
// typed or imported. One form means a call or a WhatsApp message can be matched to its contact,
// and the same number typed two ways is recognised as the same.

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * @param {unknown} input  "98765 43210", "09876543210", "919876543210", "+91-98765-43210",
 *                         "020 2612 3456" (landline with its area code), "+1 415 555 0100" …
 * @param {string} [defaultCountryCode]  Used when the number has no country code. India: "91"
 * @returns {string | null} The international form, or null when it is not a usable number
 */
export function normalizePhone(input, defaultCountryCode = '91') {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (!digits) return null;

  let result;
  if (text.startsWith('+')) {
    result = `+${digits}`;
  } else if (digits.startsWith('00')) {
    // "00" is the international prefix on many phones.
    result = `+${digits.slice(2)}`;
  } else {
    // A leading 0 is the national prefix: not part of the number.
    const national = digits.replace(/^0+/, '');
    if (national.length === 10) result = `+${defaultCountryCode}${national}`;
    else if (national.length === 12 && national.startsWith(defaultCountryCode))
      result = `+${national}`;
    else return null;
  }
  return E164.test(result) ? result : null;
}

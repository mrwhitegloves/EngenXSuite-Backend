// Every successful response has the same shape: { data } or { data, meta }.
// Errors are shaped in middleware/errorHandler.js: { error: { code, message, details?, requestId } }.

/** @param {import('express').Response} res @param {unknown} data */
export function sendOk(res, data) {
  res.status(200).json({ data });
}

/** @param {import('express').Response} res @param {unknown} data */
export function sendCreated(res, data) {
  res.status(201).json({ data });
}

/**
 * @param {import('express').Response} res
 * @param {unknown[]} items
 * @param {{ page: number, pageSize: number, total: number }} pagination
 */
export function sendList(res, items, pagination) {
  res.status(200).json({ data: items, meta: pagination });
}

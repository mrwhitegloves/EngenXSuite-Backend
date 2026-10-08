import { badRequest } from '../lib/errors.js';

/**
 * Route middleware: validate params, query and body with Zod schemas BEFORE the controller runs.
 * The parsed (and type-converted) values replace the raw ones on `req.validated`, so a controller
 * never reads unvalidated input:
 *
 *   router.patch('/:id', validate({ params: idParams, body: updateAccountBody }), updateAccount)
 *   // in the controller: const { params, body } = req.validated;
 *
 * @param {{ params?: import('zod').ZodType, query?: import('zod').ZodType, body?: import('zod').ZodType }} schemas
 */
export function validate(schemas) {
  return function validateRequest(req, res, next) {
    const validated = {};
    const issues = [];

    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ in: part, field: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) return next(badRequest('Some fields are not valid', issues));
    req.validated = validated;
    return next();
  };
}

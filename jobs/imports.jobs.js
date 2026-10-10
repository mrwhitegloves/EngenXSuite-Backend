import { runImport, runImportUndo, runWhenFree } from '../services/imports.service.js';

// CSV import jobs (queue "integrations"). The job data holds only the import's id.
// Both are safe to run twice: an import can be claimed by one run only, a finished import is
// left alone, and a run that was cut off goes on at the row where it stopped.

/** Save the rows of an import. */
export function runImportJob({ importId }) {
  return runWhenFree(runImport, importId);
}

/** Remove what an import created. */
export function runImportUndoJob({ importId }) {
  return runWhenFree(runImportUndo, importId);
}

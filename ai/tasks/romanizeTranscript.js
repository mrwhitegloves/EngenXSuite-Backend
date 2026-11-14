import { z } from 'zod';
import { runAiTask } from '../runTask.js';

// Founder decision (2026-11-14): meeting transcripts are written in Roman letters, also what
// was said in Hindi ("budget kitna hai", never "बजट कितना है"). An audio-to-text model often
// writes Hindi in Devanagari; this task rewrites such a piece letter by letter. It is NOT a
// translation: the words stay Hindi, English words stay English.
// Runs only for a piece that holds Devanagari letters.

export const ROMANIZE_TRANSCRIPT_VERSION = 'romanizeTranscript/v1';

export const DEVANAGARI = /[ऀ-ॿ]/;

export const romanizeSchema = z.object({ text: z.string().trim().max(20000) });

const SYSTEM = `You get a piece of a spoken business meeting in India, written by a speech-to-text model. Parts of it are in Devanagari letters.
Rewrite it so that every word is in Roman (Latin) letters, the way Indians type Hindi on a phone ("budget kitna hai", "hum next week demo dikha denge").

Rules:
- Transliterate, never translate: a Hindi word stays the same Hindi word, only in Roman letters.
- Words that are English (also when written in Devanagari, like "मशीन" or "प्लांट") are written as the normal English word ("machine", "plant").
- Keep numbers, names, units and the order of the words. Add nothing, leave nothing out, do not correct the grammar.
- Plain text only.

Answer with one JSON object and nothing else: { "text": "…" }`;

/**
 * @param {{ text: string, meetingId: unknown }} input
 * @returns {Promise<{ output: { text: string }, runId: string }>}
 */
export function romanizeTranscript({ text, meetingId }) {
  return runAiTask({
    task: 'romanizeTranscript',
    promptVersion: ROMANIZE_TRANSCRIPT_VERSION,
    modelClass: 'fast',
    system: SYSTEM,
    user: JSON.stringify({ text }),
    schema: romanizeSchema,
    inputRefs: [{ kind: 'meetings', id: meetingId }],
    entityType: 'meetings',
    entityId: meetingId,
    maxTokens: 2500,
  });
}

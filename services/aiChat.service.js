import { AI_CHAT } from '../ai/config.js';
import { runAiChat, runAiTranscription } from '../ai/runChat.js';
import { badRequest, notFound } from '../lib/errors.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { User } from '../models/user.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { transcriptTextOf } from './callTranscripts.service.js';
import { loadCallForAction } from './calls.service.js';
import { accountContextFor, contactContextFor, leadContextFor } from './insights.service.js';
import { loadLeadForAction } from './opportunities.service.js';

// The AI assistant: a conversation about CRM records the person chose, and about files they
// added. Founder decisions (2026-10-12):
//   - The conversation lives in the person's browser. NOTHING of it is saved here: no message,
//     no answer, no file. Only a line "who, when, which model, what it cost" in `ai_runs`.
//   - It answers only from records the person may see. It does not look anything up by
//     itself: each turn, the records the person attached are loaded HERE, with their access
//     checks, and put into the prompt. A record they may not see answers "not found".
//   - It changes nothing in the CRM.

const SYSTEM = `You are the AI assistant inside a CRM of a company that sells industrial AI, digital transformation and engineering solutions to factories in India. You help its sales people with their own leads, companies, people, calls and files.

Rules:
- Always answer in plain, simple, correct English, also when the question, the records or a transcript are in Hindi or Hinglish. Quote a customer's own words only when asked.
- Use only the CRM records, the files and the conversation you are given. Never invent a fact, a number, a name or a date. When something is not there, say that it is not in the records.
- You cannot see any other record of the CRM, and you cannot change anything in it. When asked to, say what the person can do themselves.
- Never decide a price, a discount, a change of owner or a change of stage. You may explain what to think about.
- Be short and concrete. Use short paragraphs or a short list. No filler, no flattery.
- Money in the records is in Indian rupees.`;

const clip = (text, limit = AI_CHAT.maxAttachmentCharacters) =>
  text.length > limit ? `${text.slice(0, limit)}\n[… cut here: the rest was too long]` : text;

/**
 * One record the person attached, loaded with their access check, as text for the prompt.
 * @returns {Promise<{ title: string, body: string, ref: { kind: string, id: unknown } }>}
 */
async function loadRecord(actor, { type, id }) {
  if (type === 'lead') {
    const lead = await loadLeadForAction(actor, id, 'view');
    const { context } = await leadContextFor(lead);
    return { title: `Lead "${lead.name}"`, body: context, ref: { kind: 'opportunities', id } };
  }
  if (type === 'account') {
    const account = await loadAccountForAction(actor, id, 'view');
    const { context } = await accountContextFor(actor, account);
    return { title: `Company "${account.name}"`, body: context, ref: { kind: 'accounts', id } };
  }
  if (type === 'contact') {
    const contact = await Contact.findOne({ _id: id, deletedAt: null }).lean();
    if (!contact) throw notFound('Contact not found');
    const account = await loadAccountForAction(actor, contact.accountId, 'view').catch(() => {
      throw notFound('Contact not found');
    });
    return {
      title: `Person "${contact.name}"`,
      body: contactContextFor(contact, account),
      ref: { kind: 'contacts', id },
    };
  }
  // A call: by the "calls" permission (own, team, everyone).
  const call = await loadCallForAction(actor, id, 'view');
  const [contact, account, user, transcript] = await Promise.all([
    call.contactId ? Contact.findById(call.contactId).select('name designation').lean() : null,
    call.accountId ? Account.findById(call.accountId).select('name').lean() : null,
    call.userId ? User.findById(call.userId).select('name').lean() : null,
    transcriptTextOf(call._id),
  ]);
  return {
    title: `Phone call ${call.direction === 'inbound' ? 'from' : 'to'} ${contact?.name ?? 'an unknown number'}`,
    body: {
      direction: call.direction,
      date: call.startedAt ?? call.createdAt,
      howItEnded: call.status,
      talkedSeconds: call.durationSec ?? 0,
      ourPerson: user?.name,
      theirPerson: contact
        ? [contact.name, contact.designation].filter(Boolean).join(', ')
        : undefined,
      company: account?.name,
      outcomeSetBySales: call.outcome,
      transcript: transcript
        ? clip(transcript)
        : 'There is no text of this call yet. It can be made from the recording on the call.',
    },
    ref: { kind: 'calls', id },
  };
}

const asText = (body) => (typeof body === 'string' ? body : JSON.stringify(body));

/**
 * One turn of the assistant.
 * @param {{ messages: { role: 'user' | 'assistant', content: string,
 *                       attachments?: { name: string, text: string }[] }[],
 *           instruction?: string,
 *           context?: { type: 'lead' | 'account' | 'contact' | 'call', id: string }[] }} turn
 *        Validated. The last message is the person's new one.
 * @returns {Promise<{ reply: string, model: string, records: { type: string, id: string, title: string }[] }>}
 */
export async function chat(actor, { messages, instruction, context = [] }) {
  // The attached records, loaded now: what the person may not see stops the turn (404).
  const records = [];
  for (const item of context) records.push({ ...item, ...(await loadRecord(actor, item)) });

  const system = [
    SYSTEM,
    `The person you are talking to: ${actor.name} (${actor.role?.name ?? 'user'}). Today: ${new Date().toISOString().slice(0, 10)}.`,
    instruction ? `How this person wants the answers:\n${instruction}` : '',
    records.length
      ? `CRM records attached to this conversation (current, as JSON):\n${records
          .map((record) => `### ${record.title}\n${clip(asText(record.body))}`)
          .join('\n\n')}`
      : 'No CRM record is attached to this conversation. If the question needs one, ask the person to attach the lead, company, person or call.',
  ]
    .filter(Boolean)
    .join('\n\n');

  // A message and its files as one text. The newest messages are kept when it gets too long.
  const turns = messages.map((message) => ({
    role: message.role,
    content: [
      message.content,
      ...(message.attachments ?? []).map(
        (file) => `\n[Attached file: ${file.name}]\n${clip(file.text)}`,
      ),
    ].join(''),
  }));
  let total = system.length;
  const kept = [];
  for (const turn of [...turns].reverse()) {
    total += turn.content.length;
    if (kept.length > 0 && total > AI_CHAT.maxPromptCharacters) break;
    kept.unshift(turn);
  }
  // The model needs the conversation to start with the person.
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();

  const answer = await runAiChat({
    task: 'chat',
    modelClass: 'balanced',
    system,
    messages: kept,
    userId: actor._id,
    inputRefs: records.map((record) => record.ref),
  });
  return {
    reply: answer.text,
    model: answer.model,
    records: records.map(({ type, id, title }) => ({ type, id, title })),
  };
}

const AUDIO_FORMATS = {
  mp3: 'mp3',
  mpeg: 'mp3',
  wav: 'wav',
  m4a: 'm4a',
  mp4: 'm4a',
  ogg: 'ogg',
  webm: 'webm',
  aac: 'aac',
  flac: 'flac',
};
const TEXT_TYPES = /^(text\/|application\/(json|xml|csv))/;
const extensionOf = (name) => String(name).toLowerCase().split('.').pop();

/**
 * Turn a file the person added to a chat into text, which their browser keeps with the chat.
 * The file itself is not stored anywhere.
 *   text, CSV, JSON : read as it is
 *   audio           : audio-to-text
 *   PDF, image      : read by a model that can see it
 * @param {{ originalname: string, mimetype: string, buffer: Buffer }} file  From the upload
 * @returns {Promise<{ name: string, kind: 'text' | 'audio' | 'document' | 'image', text: string }>}
 */
export async function readChatFile(actor, file) {
  const name = String(file.originalname).slice(0, 120);
  const type = String(file.mimetype ?? '');
  const extension = extensionOf(name);

  if (TEXT_TYPES.test(type) || ['txt', 'csv', 'md', 'json', 'log'].includes(extension)) {
    return { name, kind: 'text', text: clip(file.buffer.toString('utf8')) };
  }
  if (type.startsWith('audio/') || AUDIO_FORMATS[extension]) {
    const format = AUDIO_FORMATS[extension] ?? AUDIO_FORMATS[type.split('/')[1]] ?? 'mp3';
    const result = await runAiTranscription({ audio: file.buffer, format, userId: actor._id });
    if (!result.text) throw badRequest('No speech was heard in this audio file.');
    return { name, kind: 'audio', text: clip(result.text) };
  }
  const isPdf = type === 'application/pdf' || extension === 'pdf';
  if (isPdf || type.startsWith('image/')) {
    const data = `data:${isPdf ? 'application/pdf' : type};base64,${file.buffer.toString('base64')}`;
    const answer = await runAiChat({
      task: 'readFile',
      modelClass: 'fast',
      system:
        'You turn a document or a picture into plain text for a colleague who cannot see it. Write out all the text that is in it, in reading order, with tables as rows. For a picture without text, describe what it shows in a few sentences. Add nothing of your own. Write in English; keep names, numbers and quoted words as they are.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `The file "${name}":` },
            isPdf
              ? { type: 'file', file: { filename: name, file_data: data } }
              : { type: 'image_url', image_url: { url: data } },
          ],
        },
      ],
      userId: actor._id,
      maxTokens: 6000,
    });
    return { name, kind: isPdf ? 'document' : 'image', text: clip(answer.text) };
  }
  throw badRequest(
    'This kind of file cannot be read. Use a PDF, a picture, an audio file, or a text or CSV file.',
  );
}

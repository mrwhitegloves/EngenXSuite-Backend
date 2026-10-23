import { suggestWhatsAppReply, summarizeWhatsAppChat } from '../ai/tasks/whatsappAssist.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { WhatsAppMessage } from '../models/whatsapp.model.js';
import { loadConversation } from './whatsapp.service.js';

// The AI's helps on a WhatsApp chat (ai/tasks/whatsappAssist.js), only on a person's click.
// Nothing here sends a message or changes a record.

const CHAT_LENGTH = 30;

async function chatOf(conversation) {
  const messages = await WhatsAppMessage.find({
    conversationId: conversation._id,
    type: { $ne: 'reaction' },
    status: { $ne: 'failed' },
  })
    .sort({ sentAt: -1 })
    .limit(CHAT_LENGTH)
    .lean();
  return messages.reverse().map((message) => ({
    from: message.direction === 'inbound' ? 'customer' : 'us',
    kind: message.type,
    date: message.sentAt.toISOString().slice(0, 16).replace('T', ' '),
    text: (message.text || message.media?.fileName || '').slice(0, 1500),
  }));
}

async function customerOf(conversation) {
  const [contact, account, lead] = await Promise.all([
    conversation.contactId
      ? Contact.findById(conversation.contactId).select('name designation').lean()
      : null,
    conversation.accountId
      ? Account.findById(conversation.accountId).select('name industry').lean()
      : null,
    conversation.opportunityId
      ? Opportunity.findById(conversation.opportunityId).select('name stageId').lean()
      : null,
  ]);
  const stage = lead?.stageId
    ? await PipelineStage.findById(lead.stageId).select('name').lean()
    : null;
  return {
    person: contact?.name ?? conversation.profileName ?? undefined,
    role: contact?.designation ?? undefined,
    company: account?.name ?? undefined,
    industry: account?.industry ?? undefined,
    lead: lead?.name ?? undefined,
    stage: stage?.name ?? undefined,
  };
}

/**
 * One of the AI's helps on a chat.
 *   suggest : a reply to the customer's newest message, questions to ask, the next step, tips
 *   summary : what the chat is about and where it stands
 * @param {{ kind: 'suggest' | 'summary' }} request  Validated
 */
export async function assistOnConversation(actor, conversationId, { kind }) {
  const conversation = await loadConversation(actor, conversationId);
  const messages = await chatOf(conversation);
  if (!messages.some((message) => message.from === 'customer')) {
    return {
      kind,
      note: 'No message from them yet. Start with a template.',
      result: null,
    };
  }
  const base = {
    messages,
    customer: await customerOf(conversation),
    conversationId: conversation._id,
    userId: actor._id,
  };
  if (kind === 'summary') {
    return { kind, note: null, result: (await summarizeWhatsAppChat(base)).output };
  }
  const { output } = await suggestWhatsAppReply({
    ...base,
    sender: String(actor.name ?? '').split(' ')[0] || undefined,
  });
  return { kind, note: null, result: output };
}

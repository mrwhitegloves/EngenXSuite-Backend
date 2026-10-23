import mongoose from 'mongoose';

// WhatsApp with customers: one conversation per customer number, and its messages.
// Written only by services/whatsapp.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const WHATSAPP_MESSAGE_TYPES = [
  'text',
  'template',
  'image',
  'video',
  'document',
  'audio',
  'sticker',
  'location',
  'reaction',
  'other',
];
// A file of a message: saved in our private S3 bucket. "pending" while an incoming file is
// still being fetched from Meta; "failed" when it could not be.
export const WHATSAPP_MEDIA_STATUSES = ['pending', 'ready', 'failed'];
// How far a message of ours got; "received" is a message of the customer.
export const WHATSAPP_MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'received',
];

const whatsappConversationSchema = new mongoose.Schema(
  {
    // The customer's WhatsApp number: digits with the country code, no plus ("919876543210").
    waId: { type: String, required: true, unique: true },
    // The name the customer gave themselves on WhatsApp; shown until a contact is linked.
    profileName: { type: String, maxlength: 200 },
    // Who it is. Found by the phone number; empty for a number that is not in the CRM.
    contactId: { type: ObjectId, ref: 'Contact' },
    accountId: { type: ObjectId, ref: 'Account' },
    opportunityId: { type: ObjectId, ref: 'Opportunity' },
    // Who answers it; starts as the owner of the contact.
    assignedTo: { type: ObjectId, ref: 'User' },
    snippet: { type: String, maxlength: 300 },
    // Who wrote the last message: the list shows "You:" before ours.
    lastDirection: { type: String, enum: ['inbound', 'outbound'] },
    lastMessageAt: { type: Date },
    // The customer's last message: we may answer freely for 24 hours after it.
    lastInboundAt: { type: Date },
    // Our last message (a person's or a template): "needs reply" compares the two.
    lastOutboundAt: { type: Date },
    unreadCount: { type: Number, required: true, default: 0 },
    status: { type: String, enum: ['open', 'closed'], required: true, default: 'open' },
  },
  { timestamps: true, versionKey: false, collection: 'whatsapp_conversations' },
);
whatsappConversationSchema.index({ contactId: 1 });
whatsappConversationSchema.index({ assignedTo: 1, lastMessageAt: -1 });
whatsappConversationSchema.index({ accountId: 1 });
whatsappConversationSchema.index({ opportunityId: 1 });
whatsappConversationSchema.index({ lastMessageAt: -1 });

const whatsappMessageSchema = new mongoose.Schema(
  {
    conversationId: { type: ObjectId, ref: 'WhatsAppConversation', required: true },
    // Meta's id of the message: the same message arriving twice is stored once.
    wamid: { type: String },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    type: { type: String, enum: WHATSAPP_MESSAGE_TYPES, required: true },
    text: { type: String, maxlength: 5000 },
    // For a template message: which approved template it was.
    templateName: { type: String, maxlength: 120 },
    // The file of a picture, video, voice message, document or sticker (and a template's header).
    media: {
      type: new mongoose.Schema(
        {
          // The S3 address (private); answers carry a signed link instead.
          url: { type: String },
          // Meta's id of an incoming file, until it is saved with us.
          providerMediaId: { type: String },
          mimeType: { type: String, maxlength: 120 },
          fileName: { type: String, maxlength: 255 },
          size: { type: Number },
          status: { type: String, enum: WHATSAPP_MEDIA_STATUSES, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // The message this one answers (WhatsApp's "reply"), when we have it.
    replyToId: { type: ObjectId, ref: 'WhatsAppMessage' },
    // A reaction: the emoji, on the message with this Meta id.
    reaction: {
      type: new mongoose.Schema({ emoji: String, wamid: String }, { _id: false }),
      default: undefined,
    },
    // A shared location.
    location: {
      type: new mongoose.Schema(
        { latitude: Number, longitude: Number, name: String, address: String },
        { _id: false },
      ),
      default: undefined,
    },
    status: { type: String, enum: WHATSAPP_MESSAGE_STATUSES, required: true },
    errorCode: { type: String },
    errorMessage: { type: String, maxlength: 300 },
    sentBy: { type: ObjectId, ref: 'User' },
    sentAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, collection: 'whatsapp_messages' },
);
whatsappMessageSchema.index(
  { wamid: 1 },
  { unique: true, partialFilterExpression: { wamid: { $type: 'string' } } },
);
whatsappMessageSchema.index({ conversationId: 1, sentAt: 1 });

export const WhatsAppConversation =
  mongoose.models.WhatsAppConversation ??
  mongoose.model('WhatsAppConversation', whatsappConversationSchema);
export const WhatsAppMessage =
  mongoose.models.WhatsAppMessage ?? mongoose.model('WhatsAppMessage', whatsappMessageSchema);

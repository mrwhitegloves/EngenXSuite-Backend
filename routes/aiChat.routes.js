import { Router } from 'express';
import { AI_AUDIO_MAX_BYTES } from '../ai/config.js';
import { postChat, postChatFile } from '../controllers/aiChat.controller.js';
import { authorize } from '../middleware/authorize.js';
import { createAiLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { singleFileUpload } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { chatBody } from '../validation/insights.js';

// The AI assistant (/api/ai). For people who may use AI insights. Which records a person may
// talk about is decided in the service, record by record. Every request costs a little money:
// rate limited per person.
export const aiChatRouter = Router();
const aiLimiter = createAiLimiter();
aiChatRouter.use(requireAuth);
aiChatRouter.post(
  '/chat',
  authorize('ai_insights', 'view'),
  aiLimiter,
  validate({ body: chatBody }),
  postChat,
);
aiChatRouter.post(
  '/chat/files',
  authorize('ai_insights', 'view'),
  aiLimiter,
  singleFileUpload({ maxBytes: AI_AUDIO_MAX_BYTES }),
  postChatFile,
);

import { Router } from 'express';
import {
  getAccountInsight,
  getAiSettings,
  getLeadInsight,
  patchAiSettings,
  postAcceptAction,
  postAccountInsight,
  postFeedback,
  postLeadInsight,
} from '../controllers/insights.controller.js';
import { authorize } from '../middleware/authorize.js';
import { createAiLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { feedbackBody, updateAiSettingsBody } from '../validation/insights.js';

// ── AI insights about one record. authorize() answers "may this person use AI insights at
// all"; whether they may see that company or lead is decided in the service (404 when not).
// Asking the AI for a new answer costs money: it is rate limited per person.
export const insightsRouter = Router();
const FEATURE = 'ai_insights';
const byId = validate({ params: idParams });
const aiLimiter = createAiLimiter();
insightsRouter.use(requireAuth);
insightsRouter.get('/accounts/:id', authorize(FEATURE, 'view'), byId, getAccountInsight);
insightsRouter.post(
  '/accounts/:id/refresh',
  authorize(FEATURE, 'view'),
  aiLimiter,
  byId,
  postAccountInsight,
);
insightsRouter.get('/leads/:id', authorize(FEATURE, 'view'), byId, getLeadInsight);
insightsRouter.post(
  '/leads/:id/refresh',
  authorize(FEATURE, 'view'),
  aiLimiter,
  byId,
  postLeadInsight,
);

// What a person thinks of an answer (":id" is the insight's id).
insightsRouter.post(
  '/:id/feedback',
  authorize(FEATURE, 'view'),
  validate({ params: idParams, body: feedbackBody }),
  postFeedback,
);
insightsRouter.post('/:id/accept-action', authorize(FEATURE, 'view'), byId, postAcceptAction);

// ── Settings → AI.
export const aiSettingsRouter = Router();
aiSettingsRouter.use(requireAuth);
aiSettingsRouter.get('/', authorize('settings', 'view'), getAiSettings);
aiSettingsRouter.patch(
  '/',
  authorize('settings', 'edit'),
  validate({ body: updateAiSettingsBody }),
  patchAiSettings,
);

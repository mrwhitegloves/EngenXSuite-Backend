import { Router } from 'express';
import { getPublicStopPage, postPublicStop } from '../controllers/campaigns.controller.js';
import {
  getPublicPage,
  getPublicSlots,
  postPublicBooking,
} from '../controllers/meetingTypes.controller.js';
import { getPublicBranding, getPublicConfig } from '../controllers/public.controller.js';
import { createBookingLimiter, createStopMailLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { stopTokenParams } from '../validation/campaigns.js';
import { bookSlotBody, bookingSlugParams, slotsQuery } from '../validation/meetings.js';

// Routes that need no sign-in. Keep this list short: every route here is reachable by anyone.
const router = Router();

router.get('/branding', getPublicBranding);
router.get('/config', getPublicConfig);

// The public booking page of one person. Free times only: never what a calendar holds.
router.get('/booking/:slug', validate({ params: bookingSlugParams }), getPublicPage);
router.get(
  '/booking/:slug/slots',
  validate({ params: bookingSlugParams, query: slotsQuery }),
  getPublicSlots,
);
router.post(
  '/booking/:slug/book',
  createBookingLimiter(),
  validate({ params: bookingSlugParams, body: bookSlotBody }),
  postPublicBooking,
);

// The link at the foot of a bulk mail: the customer stops such mails to their own address.
// The link is signed, so it works only for the address it was sent to.
router.get('/stop-mail/:token', validate({ params: stopTokenParams }), getPublicStopPage);
router.post(
  '/stop-mail/:token',
  createStopMailLimiter(),
  validate({ params: stopTokenParams }),
  postPublicStop,
);

export default router;

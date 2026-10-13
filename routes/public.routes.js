import { Router } from 'express';
import {
  getPublicPage,
  getPublicSlots,
  postPublicBooking,
} from '../controllers/meetingTypes.controller.js';
import { getPublicBranding, getPublicConfig } from '../controllers/public.controller.js';
import { createBookingLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
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

export default router;

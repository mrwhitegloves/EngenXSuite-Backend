import { Router } from 'express';
import {
  getBookingPage,
  getMeetingTypes,
  patchBookingPage,
  patchMeetingType,
  postMeetingType,
  removeMeetingType,
} from '../controllers/meetingTypes.controller.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  createMeetingTypeBody,
  updateBookingPageBody,
  updateMeetingTypeBody,
} from '../validation/meetings.js';

// The kinds of meeting (/api/meeting-types): read by everyone who uses meetings, changed by
// the people who manage the settings.
export const meetingTypesRouter = Router();
meetingTypesRouter.use(requireAuth);
meetingTypesRouter.get('/', authorize('meetings', 'view'), getMeetingTypes);
meetingTypesRouter.post(
  '/',
  authorize('settings', 'edit'),
  validate({ body: createMeetingTypeBody }),
  postMeetingType,
);
meetingTypesRouter.patch(
  '/:id',
  authorize('settings', 'edit'),
  validate({ params: idParams, body: updateMeetingTypeBody }),
  patchMeetingType,
);
meetingTypesRouter.delete(
  '/:id',
  authorize('settings', 'edit'),
  validate({ params: idParams }),
  removeMeetingType,
);

// A person's own booking page (/api/booking-page).
export const bookingPageRouter = Router();
bookingPageRouter.use(requireAuth);
bookingPageRouter.get('/', authorize('meetings', 'create'), getBookingPage);
bookingPageRouter.patch(
  '/',
  authorize('meetings', 'create'),
  validate({ body: updateBookingPageBody }),
  patchBookingPage,
);

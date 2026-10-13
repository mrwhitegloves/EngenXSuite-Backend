import { sendCreated, sendOk } from '../lib/respond.js';
import {
  bookSlot,
  getFreeSlots,
  getMyBookingPage,
  getPublicBookingPage,
  updateMyBookingPage,
} from '../services/bookingPages.service.js';
import {
  createMeetingType,
  deleteMeetingType,
  listMeetingTypes,
  updateMeetingType,
} from '../services/meetingTypes.service.js';

// Meeting types (Settings), a person's own booking page, and the public booking page.
// Each function: read the validated request, call one service function, respond.

// GET /api/meeting-types
export async function getMeetingTypes(req, res) {
  sendOk(res, await listMeetingTypes());
}

// POST /api/meeting-types
export async function postMeetingType(req, res) {
  sendCreated(res, await createMeetingType(req.user, req.validated.body, { requestId: req.id }));
}

// PATCH /api/meeting-types/:id
export async function patchMeetingType(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateMeetingType(req.user, params.id, body, { requestId: req.id }));
}

// DELETE /api/meeting-types/:id
export async function removeMeetingType(req, res) {
  sendOk(res, await deleteMeetingType(req.user, req.validated.params.id, { requestId: req.id }));
}

// GET /api/booking-page: my own booking page.
export async function getBookingPage(req, res) {
  sendOk(res, await getMyBookingPage(req.user));
}

// PATCH /api/booking-page
export async function patchBookingPage(req, res) {
  sendOk(res, await updateMyBookingPage(req.user, req.validated.body));
}

// GET /api/public/booking/:slug: what a customer sees. No sign-in.
export async function getPublicPage(req, res) {
  sendOk(res, await getPublicBookingPage(req.validated.params.slug));
}

// GET /api/public/booking/:slug/slots: the free times of one day. No sign-in.
export async function getPublicSlots(req, res) {
  const { params, query } = req.validated;
  sendOk(res, await getFreeSlots(params.slug, query));
}

// POST /api/public/booking/:slug/book: a customer books a time. No sign-in.
export async function postPublicBooking(req, res) {
  const { params, body } = req.validated;
  sendCreated(res, await bookSlot(params.slug, body));
}

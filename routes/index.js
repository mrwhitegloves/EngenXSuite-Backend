import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import publicRoutes from './public.routes.js';
import usersRoutes from './users.routes.js';
import rolesRoutes from './roles.routes.js';
import jobsRoutes from './jobs.routes.js';
import auditRoutes from './audit.routes.js';
import backupsRoutes from './backups.routes.js';
import savedViewsRoutes from './savedViews.routes.js';
import settingsRoutes from './settings.routes.js';
import realtimeRoutes from './realtime.routes.js';
import accountsRoutes from './accounts.routes.js';
import statusListsRoutes from './statusLists.routes.js';
import { contactsRouter, machinesRouter, plantUnitsRouter, plantsRouter } from './plants.routes.js';
import tagsRoutes from './tags.routes.js';
import importsRoutes from './imports.routes.js';
import opportunitiesRoutes from './opportunities.routes.js';
import { notesRouter, tasksRouter, timelineRouter } from './activities.routes.js';
import notificationsRoutes from './notifications.routes.js';
import { dashboardRouter, searchRouter } from './search.routes.js';
import { callSettingsRouter, callsRouter, plivoWebhooksRouter } from './calls.routes.js';
import { aiChatRouter } from './aiChat.routes.js';
import documentsRoutes from './documents.routes.js';
import emailsRoutes, { googleWebhooksRouter } from './emails.routes.js';
import bundlesRoutes from './bundles.routes.js';
import campaignsRoutes from './campaigns.routes.js';
import meetingsRoutes from './meetings.routes.js';
import whatsappRoutes, { whatsappWebhooksRouter } from './whatsapp.routes.js';
import { bookingPageRouter, meetingTypesRouter } from './meetingTypes.routes.js';
import googleConnectionRoutes from './googleConnection.routes.js';
import { aiSettingsRouter, insightsRouter } from './insights.routes.js';
import {
  inboundLeadsRouter,
  leadAssignmentRouter,
  leadFormsRouter,
  webhooksRouter,
} from './inboundLeads.routes.js';

// Every API route file is mounted here, under /api. Add one line per feature.
const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/public', publicRoutes);
router.use('/users', usersRoutes);
router.use('/roles', rolesRoutes);
router.use('/jobs', jobsRoutes);
router.use('/audit-logs', auditRoutes);
router.use('/backups', backupsRoutes);
router.use('/saved-views', savedViewsRoutes);
// Before the general settings routes, so this path is found here.
router.use('/settings/lead-assignment', leadAssignmentRouter);
router.use('/settings/calls', callSettingsRouter);
router.use('/settings/ai', aiSettingsRouter);
router.use('/settings', settingsRoutes);
router.use('/realtime', realtimeRoutes);
router.use('/accounts', accountsRoutes);
router.use('/status-lists', statusListsRoutes);
router.use('/contacts', contactsRouter);
router.use('/plants', plantsRouter);
router.use('/machines', machinesRouter);
router.use('/plant-units', plantUnitsRouter);
router.use('/tags', tagsRoutes);
router.use('/imports', importsRoutes);
router.use('/opportunities', opportunitiesRoutes);
router.use('/timeline', timelineRouter);
router.use('/notes', notesRouter);
router.use('/tasks', tasksRouter);
router.use('/notifications', notificationsRoutes);
router.use('/search', searchRouter);
router.use('/dashboard', dashboardRouter);
router.use('/webhooks/plivo', plivoWebhooksRouter);
router.use('/webhooks/google', googleWebhooksRouter);
router.use('/webhooks/meta', whatsappWebhooksRouter);
router.use('/webhooks', webhooksRouter);
router.use('/calls', callsRouter);
router.use('/insights', insightsRouter);
router.use('/integrations/google', googleConnectionRoutes);
router.use('/emails', emailsRoutes);
router.use('/documents', documentsRoutes);
router.use('/meetings', meetingsRoutes);
router.use('/bundles', bundlesRoutes);
router.use('/campaigns', campaignsRoutes);
router.use('/whatsapp', whatsappRoutes);
router.use('/meeting-types', meetingTypesRouter);
router.use('/booking-page', bookingPageRouter);
router.use('/ai', aiChatRouter);
router.use('/lead-forms', leadFormsRouter);
router.use('/inbound-leads', inboundLeadsRouter);

export default router;

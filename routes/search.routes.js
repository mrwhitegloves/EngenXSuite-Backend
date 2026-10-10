import { Router } from 'express';
import { getDashboardToday, getSearch } from '../controllers/search.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { searchQuery } from '../validation/search.js';

// Global search and the dashboard. Both are for every signed-in person: what each one finds
// or sees is decided in the service, part by part, by that person's permissions and scopes.
export const searchRouter = Router();
searchRouter.use(requireAuth);
searchRouter.get('/', validate({ query: searchQuery }), getSearch);

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);
dashboardRouter.get('/today', getDashboardToday);

import {
  deleteJob,
  getJobsOverview,
  listFailed,
  retryJob,
  sendTestJob,
} from '../services/jobs.service.js';
import { sendCreated, sendOk } from '../lib/respond.js';

// GET /api/jobs: how many jobs each queue holds.
export async function getJobs(req, res) {
  sendOk(res, await getJobsOverview());
}

// GET /api/jobs/failed?queue=<name>: the failed jobs of one queue, newest first.
export async function getFailedJobs(req, res) {
  const { queue, page, pageSize } = req.validated.query;
  sendOk(res, await listFailed(queue, { page, pageSize }));
}

// POST /api/jobs/:queue/:jobId/retry: run a failed job again.
export async function postRetryJob(req, res) {
  const { queue, jobId } = req.validated.params;
  sendOk(res, await retryJob(req.user, queue, jobId));
}

// DELETE /api/jobs/:queue/:jobId: delete a failed job.
export async function removeJob(req, res) {
  const { queue, jobId } = req.validated.params;
  await deleteJob(req.user, queue, jobId);
  sendOk(res, { deleted: true });
}

// POST /api/jobs/test: add the harmless test job.
export async function postTestJob(req, res) {
  sendCreated(res, await sendTestJob(req.user, req.validated.body));
}

import { Router } from 'express';

export const rootRouter = Router();

/**
 * The deployed base URL is the first thing anyone opens. Without this it returns
 * a bare "Route not found", which reads as a broken deployment even when the
 * service is perfectly healthy. This says what the service is and where to look.
 */
rootRouter.get('/', (_req, res) => {
  res.json({
    service: 'ReachInbox Email Scheduler API',
    status: 'running',
    docs: 'https://github.com/baparao15/reachinbox-email-scheduler#readme',
    endpoints: {
      health: 'GET /health',
      auth: 'POST /api/auth/google · GET /api/auth/me',
      campaigns:
        'POST /api/campaigns · POST /api/campaigns/preview · GET /api/campaigns · GET /api/campaigns/:id · POST /api/campaigns/:id/cancel',
      emails: 'GET /api/emails?status=scheduled|sent · GET /api/emails/stats',
      senders: 'GET /api/senders',
    },
    note: 'All /api routes except POST /api/auth/google require an Authorization: Bearer <token> header.',
  });
});

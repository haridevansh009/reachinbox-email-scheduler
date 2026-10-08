import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { getUserStats, listEmails } from '../services/emailService';

export const emailsRouter = Router();

const listSchema = z.object({
  status: z.enum(['scheduled', 'sent']).default('scheduled'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  campaignId: z.string().uuid().optional(),
});

/**
 * `status=scheduled` → the Scheduled Emails tab (pending + in-flight).
 * `status=sent`      → the Sent Emails tab (sent + failed).
 */
emailsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const query = listSchema.parse(req.query);
    const result = await listEmails({
      userId: req.user!.id,
      view: query.status,
      page: query.page,
      pageSize: query.pageSize,
      campaignId: query.campaignId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

emailsRouter.get('/stats', requireAuth, async (req, res, next) => {
  try {
    res.json(await getUserStats(req.user!.id));
  } catch (err) {
    next(err);
  }
});

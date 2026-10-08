import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env';
import { parseLeadFile, isValidEmail } from '../lib/csv';
import { badRequest } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import {
  cancelCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
} from '../services/campaignService';

export const campaignsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES },
});

/**
 * Multipart fields arrive as strings, so numbers are coerced here rather than
 * trusted from the client.
 */
const createSchema = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(500),
  body: z.string().trim().min(1, 'Body is required').max(100_000),
  startAt: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? new Date(v) : new Date()))
    .refine((d) => !Number.isNaN(d.getTime()), 'startAt must be a valid ISO date'),
  minDelayMs: z.coerce.number().int().positive().optional(),
  hourlyLimit: z.coerce.number().int().positive().optional(),
  /** Optional JSON array, for clients that already parsed the file themselves. */
  recipients: z.string().optional(),
});

campaignsRouter.post('/', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);

    let recipients: string[] = [];

    if (req.file) {
      const parsed = parseLeadFile(req.file.buffer.toString('utf8'));
      recipients = parsed.emails;
    } else if (input.recipients) {
      let raw: unknown;
      try {
        raw = JSON.parse(input.recipients);
      } catch {
        throw badRequest('`recipients` must be a JSON array of email addresses');
      }
      if (!Array.isArray(raw)) throw badRequest('`recipients` must be a JSON array');

      const seen = new Set<string>();
      for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const email = entry.trim().toLowerCase();
        if (!isValidEmail(email) || seen.has(email)) continue;
        seen.add(email);
        recipients.push(email);
      }
    } else {
      throw badRequest('Upload a CSV/text file of leads, or provide a `recipients` array.');
    }

    const result = await createCampaign({
      userId: req.user!.id,
      subject: input.subject,
      body: input.body,
      recipients,
      startAt: input.startAt,
      minDelayMs: input.minDelayMs,
      hourlyLimit: input.hourlyLimit,
    });

    res.status(201).json({
      campaign: {
        id: result.campaign.id,
        subject: result.campaign.subject,
        status: result.campaign.status,
        startAt: result.campaign.startAt.toISOString(),
        plannedEndAt: result.plannedEndAt.toISOString(),
        totalRecipients: result.totalRecipients,
        minDelayMs: result.effectiveMinDelayMs,
        hourlyLimit: result.effectiveHourlyLimit,
      },
      senderCount: result.senderCount,
      message: `Scheduled ${result.totalRecipients} email(s) across ${result.senderCount} sender(s).`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Parse-only endpoint. Lets the compose modal show "N addresses detected"
 * using the exact same parser the scheduler will use, so the preview count can
 * never disagree with what actually gets scheduled.
 */
campaignsRouter.post('/preview', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('No file uploaded');
    const parsed = parseLeadFile(req.file.buffer.toString('utf8'));
    res.json({
      count: parsed.emails.length,
      totalFound: parsed.totalFound,
      duplicatesRemoved: parsed.duplicatesRemoved,
      invalidRows: parsed.invalidRows,
      sample: parsed.emails.slice(0, 5),
    });
  } catch (err) {
    next(err);
  }
});

campaignsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await listCampaigns(req.user!.id);
    res.json({
      items: rows.map((c) => ({
        id: c.id,
        subject: c.subject,
        status: c.status,
        totalRecipients: c.totalRecipients,
        minDelayMs: c.minDelayMs,
        hourlyLimit: c.hourlyLimit,
        startAt: c.startAt.toISOString(),
        plannedEndAt: c.plannedEndAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

campaignsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { campaign, breakdown } = await getCampaign(req.user!.id, req.params.id!);
    res.json({
      campaign: {
        id: campaign.id,
        subject: campaign.subject,
        body: campaign.body,
        status: campaign.status,
        totalRecipients: campaign.totalRecipients,
        minDelayMs: campaign.minDelayMs,
        hourlyLimit: campaign.hourlyLimit,
        startAt: campaign.startAt.toISOString(),
        plannedEndAt: campaign.plannedEndAt?.toISOString() ?? null,
        createdAt: campaign.createdAt.toISOString(),
      },
      breakdown: Object.fromEntries(breakdown.map((b) => [b.status, b.total])),
    });
  } catch (err) {
    next(err);
  }
});

campaignsRouter.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const result = await cancelCampaign(req.user!.id, req.params.id!);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

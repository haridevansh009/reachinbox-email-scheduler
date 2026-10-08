import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Route not found' });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  // Postgres unique-violation — surfaced as a conflict rather than a 500.
  if ((err as { code?: string })?.code === '23505') {
    res.status(409).json({ error: 'Resource already exists' });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
}

import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../lib/errors';
import { findUserById, verifySessionToken, type SessionUser } from '../services/authService';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.session;
  return cookie ?? null;
}

/** Rejects the request unless it carries a valid backend session JWT. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized('Missing session token');

    const payload = verifySessionToken(token);
    const user = await findUserById(payload.sub);
    if (!user) throw unauthorized('User no longer exists');

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    };
    next();
  } catch (err) {
    next(err);
  }
}

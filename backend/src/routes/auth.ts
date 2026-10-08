import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import {
  issueSessionToken,
  toSessionUser,
  upsertUserFromGoogle,
  verifyGoogleIdToken,
} from '../services/authService';

export const authRouter = Router();

const googleSchema = z.object({
  idToken: z.string().min(10, 'idToken is required'),
});

/**
 * Exchanges a Google ID token for this backend's own session JWT.
 * Called once by NextAuth immediately after the Google sign-in completes.
 */
authRouter.post('/google', async (req, res, next) => {
  try {
    const { idToken } = googleSchema.parse(req.body);

    const profile = await verifyGoogleIdToken(idToken);
    const user = await upsertUserFromGoogle(profile);
    const token = issueSessionToken(user);

    res.json({ token, user: toSessionUser(user) });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

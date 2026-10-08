import { randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { env } from '../config/env';
import { db } from '../db';
import { users, type UserRow } from '../db/schema';
import { unauthorized } from '../lib/errors';

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
}

/**
 * Verifies a Google ID token server-side.
 *
 * The frontend never asserts who the user is — it hands over the raw id_token
 * and the backend checks the signature, issuer and audience against Google's
 * public keys before trusting a single field.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<{
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}> {
  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
  } catch (err) {
    throw unauthorized('Google ID token verification failed');
  }

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw unauthorized('Google ID token is missing required claims');
  }
  if (payload.email_verified === false) {
    throw unauthorized('Google account email is not verified');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name ?? null,
    picture: payload.picture ?? null,
  };
}

export async function upsertUserFromGoogle(profile: {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}): Promise<UserRow> {
  const existing = await db.select().from(users).where(eq(users.googleSub, profile.sub)).limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(users)
      .set({
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.picture,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing[0].id))
      .returning();
    return updated ?? existing[0];
  }

  const [created] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
    })
    .returning();

  if (!created) throw new Error('Failed to create user');
  return created;
}

export function issueSessionToken(user: UserRow): string {
  const payload: AuthTokenPayload = { sub: user.id, email: user.email };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifySessionToken(token: string): AuthTokenPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
  } catch {
    throw unauthorized('Session token is invalid or expired');
  }
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export const toSessionUser = (user: UserRow): SessionUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatarUrl: user.avatarUrl,
});

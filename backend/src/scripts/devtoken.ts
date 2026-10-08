/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '../db';
import { users } from '../db/schema';
import { issueSessionToken } from '../services/authService';

/**
 * Prints a backend session JWT so the API can be exercised from curl or Postman
 * without going through the Google OAuth flow.
 *
 *   npm run devtoken                     # reuses/creates dev@reachinbox.local
 *   npm run devtoken -- you@example.com  # a specific user
 *
 * Development convenience only — it mints a token for a local user row. It does
 * not bypass verification for anyone who signs in through the real Google flow.
 */
async function main() {
  const email = process.argv[2] ?? 'dev@reachinbox.local';

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let user = existing[0];

  if (!user) {
    const [created] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        googleSub: `dev-${randomUUID()}`,
        email,
        name: 'Dev User',
        avatarUrl: null,
      })
      .returning();
    user = created;
    console.error(`Created dev user ${email}`);
  }

  if (!user) throw new Error('Could not create or find the dev user');

  // Token to stdout only, so `TOKEN=$(npm run devtoken --silent)` works cleanly.
  console.log(issueSessionToken(user));
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

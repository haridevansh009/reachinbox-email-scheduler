import type { DefaultSession } from 'next-auth';

/**
 * Extra fields we carry through the Auth.js session and JWT.
 *
 * `next-auth` v5 re-exports its JWT interface from `@auth/core/jwt`, so the
 * augmentation has to target that module for the fields to resolve as typed
 * rather than falling back to the `Record<string, unknown>` index signature.
 */
interface SchedulerTokenFields {
  /** JWT minted by our Express API, used as the Bearer token for every call. */
  backendToken?: string;
  userId?: string;
  authError?: string;
}

/** JWT-only fields — never exposed on the client session. */
interface SchedulerJwtFields extends SchedulerTokenFields {
  /** Kept briefly so a failed backend exchange can be retried. */
  googleIdToken?: string;
  googleIdTokenAt?: number;
}

declare module 'next-auth' {
  interface Session extends SchedulerTokenFields {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

declare module '@auth/core/jwt' {
  interface JWT extends SchedulerJwtFields {}
}

declare module 'next-auth/jwt' {
  interface JWT extends SchedulerJwtFields {}
}

export {};

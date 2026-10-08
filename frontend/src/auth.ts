import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4000';

/**
 * Google ID tokens are valid for roughly an hour. We keep ours a little under
 * that so a retry never fires with a token the backend would reject anyway.
 */
const ID_TOKEN_RETRY_WINDOW_MS = 50 * 60 * 1000;

interface ExchangeResult {
  backendToken?: string;
  userId?: string;
  avatarUrl?: string | null;
  authError?: string;
}

/** Trades a verified Google ID token for this backend's own session JWT. */
async function exchangeToken(idToken: string): Promise<ExchangeResult> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      // Don't let a hung backend stall the whole sign-in.
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return { authError: `Backend rejected sign-in (HTTP ${res.status})` };
    }

    const data = (await res.json()) as {
      token: string;
      user: { id: string; email: string; name: string | null; avatarUrl: string | null };
    };

    return { backendToken: data.token, userId: data.user.id, avatarUrl: data.user.avatarUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Backend unreachable';
    return { authError: message };
  }
}

/**
 * Real Google OAuth via Auth.js.
 *
 * The frontend never asserts identity. Immediately after Google returns an
 * `id_token`, we hand that raw token to the API, which verifies it against
 * Google's public keys and mints its own session JWT. Every subsequent API call
 * carries that backend JWT.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: { scope: 'openid email profile', prompt: 'select_account' },
      },
    }),
  ],
  pages: {
    signIn: '/login',
    error: '/login',
  },
  session: { strategy: 'jwt' },
  callbacks: {
    async jwt({ token, account, profile }) {
      // Sign-in request: Google's id_token is only available here.
      if (account?.id_token) {
        // Retained so the exchange can be retried if the backend is momentarily
        // down. Without this, a single failed call at sign-in would leave the
        // session permanently unable to reach the API until a full re-login.
        token.googleIdToken = account.id_token;
        token.googleIdTokenAt = Date.now();

        const result = await exchangeToken(account.id_token);
        token.backendToken = result.backendToken;
        token.userId = result.userId;
        token.authError = result.authError;
        if (result.avatarUrl) token.picture = result.avatarUrl;
      } else if (!token.backendToken && token.googleIdToken && token.googleIdTokenAt) {
        // Subsequent request with no usable backend token — retry while the
        // Google token is still valid, so the banner clears on its own once the
        // API comes back rather than requiring a manual sign-out.
        const age = Date.now() - token.googleIdTokenAt;
        if (age < ID_TOKEN_RETRY_WINDOW_MS) {
          const result = await exchangeToken(token.googleIdToken);
          token.backendToken = result.backendToken;
          token.userId = result.userId ?? token.userId;
          token.authError = result.authError;
          if (result.avatarUrl) token.picture = result.avatarUrl;
        } else {
          token.authError = 'Session expired before the API could be reached. Please sign in again.';
        }
      }

      // Once we hold a backend token the Google one has served its purpose.
      if (token.backendToken) {
        token.googleIdToken = undefined;
        token.googleIdTokenAt = undefined;
        token.authError = undefined;
      }

      if (profile?.picture && !token.picture) token.picture = profile.picture as string;
      return token;
    },

    async session({ session, token }) {
      session.backendToken = token.backendToken;
      session.authError = token.authError;
      if (session.user) {
        session.user.id = token.userId ?? session.user.id;
        session.user.image = (token.picture as string | undefined) ?? session.user.image;
      }
      return session;
    },
  },
});

import { Mail, ShieldCheck, Timer, Zap } from 'lucide-react';
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton';

const HIGHLIGHTS = [
  { icon: Timer, title: 'Precise scheduling', body: 'Delayed jobs fire at the exact minute you pick.' },
  { icon: Zap, title: 'Throttled delivery', body: 'Per-sender hourly caps and a minimum gap between sends.' },
  { icon: ShieldCheck, title: 'Restart-safe', body: 'Jobs survive a restart without duplicating a single email.' },
];

/**
 * Auth.js reports failures as `?error=<code>`. A single generic message makes an
 * OAuth misconfiguration nearly impossible to diagnose from the browser, so each
 * code maps to the thing that actually needs fixing.
 */
const ERROR_HINTS: Record<string, string> = {
  Configuration:
    'Server auth config is invalid — usually a wrong or missing AUTH_GOOGLE_SECRET in frontend/.env.local. Restart the dev server after changing it.',
  OAuthCallback:
    'Google rejected the callback. Check that AUTH_GOOGLE_SECRET is correct and that http://localhost:3000/api/auth/callback/google is an authorised redirect URI.',
  OAuthSignin: 'Could not start the Google flow. Check AUTH_GOOGLE_ID and your network connection.',
  OAuthAccountNotLinked: 'This email is already linked to a different sign-in method.',
  AccessDenied:
    'Google denied access. If the OAuth consent screen is in Testing mode, add this address as a test user.',
  Verification: 'That sign-in link has expired. Please try again.',
};

// Next 15 hands `searchParams` to pages as a promise.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawError = params?.error;
  const errorCode = Array.isArray(rawError) ? rawError[0] : rawError;
  const hasError = Boolean(errorCode);
  const errorHint = errorCode ? ERROR_HINTS[errorCode] : undefined;

  return (
    <main className="flex min-h-screen">
      {/* Brand panel — hidden on small screens so the form gets the full width. */}
      <section className="relative hidden w-1/2 flex-col justify-between bg-slate-900 p-12 lg:flex">
        <div className="absolute inset-0 bg-gradient-to-br from-brand-700/40 via-slate-900 to-slate-900" />

        <div className="relative flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600">
            <Mail className="h-5 w-5 text-white" />
          </div>
          <span className="text-lg font-semibold text-white">ReachInbox</span>
        </div>

        <div className="relative">
          <h1 className="text-balance text-3xl font-semibold leading-tight text-white">
            Schedule cold email at scale, without dropping a single send.
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-400">
            A production-grade scheduler backed by BullMQ and Redis, with per-sender rate limiting
            and end-to-end delivery tracking.
          </p>

          <ul className="mt-10 space-y-5">
            {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-brand-300">
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">{title}</p>
                  <p className="text-sm text-slate-400">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-slate-500">Outbox Labs · ReachInbox.ai</p>
      </section>

      <section className="flex w-full items-center justify-center px-6 py-12 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600">
              <Mail className="h-5 w-5 text-white" />
            </div>
            <span className="text-lg font-semibold text-slate-900">ReachInbox</span>
          </div>

          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Welcome back</h2>
          <p className="mt-1.5 text-sm text-slate-500">
            Sign in with Google to open your scheduling dashboard.
          </p>

          {hasError && (
            <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-medium text-red-800">
                We couldn&apos;t complete that sign-in.
              </p>
              {errorHint && <p className="mt-1 text-xs leading-relaxed text-red-700">{errorHint}</p>}
              <p className="mt-1.5 font-mono text-[11px] text-red-500">error: {errorCode}</p>
            </div>
          )}

          <div className="mt-8">
            <GoogleSignInButton />
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-slate-400">
            We only read your name, email address and avatar — nothing else.
          </p>
        </div>
      </section>
    </main>
  );
}

'use client';

import { useState } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { AlertTriangle, Gauge, Plus, RefreshCw } from 'lucide-react';
import { ComposeModal } from '@/components/compose/ComposeModal';
import { StatCards } from '@/components/dashboard/StatCards';
import { EmailTable } from '@/components/emails/EmailTable';
import { Button } from '@/components/ui/Button';
import { useEmails, useSenders, useStats } from '@/hooks/useApi';
import type { EmailView } from '@/lib/types';
import { cn, formatDuration } from '@/lib/utils';

const TABS: { id: EmailView; label: string }[] = [
  { id: 'scheduled', label: 'Scheduled Emails' },
  { id: 'sent', label: 'Sent Emails' },
];

export default function DashboardPage() {
  const { data: session, update: updateSession } = useSession();
  const [view, setView] = useState<EmailView>('scheduled');
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);

  const emails = useEmails(view, page);
  const stats = useStats();
  const senders = useSenders();

  const switchTab = (next: EmailView) => {
    setView(next);
    setPage(1);
  };

  const config = senders.data?.config;

  return (
    <div className="space-y-6">
      {/* Surfaces a failed backend token exchange, which otherwise looks like an
          empty dashboard with no explanation. */}
      {session?.authError && (
        <div className="flex flex-wrap items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1 text-sm text-amber-900">
            <p className="font-medium">Could not connect to the scheduler API</p>
            <p className="mt-0.5 text-xs text-amber-800">
              {session.authError} — start the backend, then retry. This clears itself once the API
              responds.
            </p>
          </div>
          <div className="flex gap-2">
            {/* Forces the session callback to re-run, which retries the token exchange. */}
            <Button size="sm" variant="secondary" onClick={() => void updateSession()}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void signOut({ callbackUrl: '/login' })}>
              Sign out
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">
            Track everything queued and everything delivered, in one place.
          </p>
        </div>

        <Button size="lg" onClick={() => setComposeOpen(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Compose New Email
        </Button>
      </div>

      <StatCards stats={stats.data} loading={stats.isLoading} />

      {/* Live scheduler config, straight from the backend env — makes the rate
          limiting visible during a demo instead of buried in a log. */}
      {config && senders.data && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600 shadow-card">
          <span className="flex items-center gap-1.5 font-medium text-slate-700">
            <Gauge className="h-3.5 w-3.5 text-slate-400" />
            Scheduler
          </span>
          <span>
            <span className="text-slate-400">Senders</span> {senders.data.items.length}
          </span>
          <span>
            <span className="text-slate-400">Min gap</span> {formatDuration(config.minDelayMs)}
          </span>
          <span>
            <span className="text-slate-400">Hourly limit</span>{' '}
            {config.hourlyLimitPerSender.toLocaleString()}/sender
          </span>
          <span>
            <span className="text-slate-400">Concurrency</span> {config.workerConcurrency}
          </span>
          <span>
            <span className="text-slate-400">Used this hour</span>{' '}
            {senders.data.items.reduce((sum, s) => sum + s.usedThisHour, 0).toLocaleString()}
          </span>
          {config.dryRun && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
              DRY RUN
            </span>
          )}
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6">
          <nav className="flex gap-1" role="tablist">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={view === tab.id}
                onClick={() => switchTab(tab.id)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-3.5 text-sm font-medium transition-colors',
                  view === tab.id
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
                )}
              >
                {tab.label}
                {stats.data && (
                  <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs tabular-nums text-slate-600">
                    {tab.id === 'scheduled'
                      ? stats.data.pending.toLocaleString()
                      : stats.data.completed.toLocaleString()}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <button
            type="button"
            onClick={() => void emails.refetch()}
            aria-label="Refresh"
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <RefreshCw className={cn('h-4 w-4', emails.isFetching && 'animate-spin')} />
          </button>
        </div>

        <EmailTable
          view={view}
          data={emails.data}
          isLoading={emails.isLoading}
          isError={emails.isError}
          error={emails.error as Error | null}
          page={page}
          onPageChange={setPage}
          onRetry={() => void emails.refetch()}
          onCompose={() => setComposeOpen(true)}
        />
      </section>

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />
    </div>
  );
}

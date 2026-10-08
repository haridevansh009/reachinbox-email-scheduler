'use client';

import { CheckCircle2, Clock, Send, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { EmailStats } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Stat {
  label: string;
  value: number;
  icon: LucideIcon;
  tone: string;
}

export function StatCards({ stats, loading }: { stats?: EmailStats; loading: boolean }) {
  const items: Stat[] = [
    { label: 'Scheduled', value: stats?.byStatus.scheduled ?? 0, icon: Clock, tone: 'text-amber-600 bg-amber-50' },
    { label: 'Sending', value: stats?.byStatus.processing ?? 0, icon: Send, tone: 'text-blue-600 bg-blue-50' },
    { label: 'Sent', value: stats?.byStatus.sent ?? 0, icon: CheckCircle2, tone: 'text-emerald-600 bg-emerald-50' },
    { label: 'Failed', value: stats?.byStatus.failed ?? 0, icon: XCircle, tone: 'text-red-600 bg-red-50' },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {items.map(({ label, value, icon: Icon, tone }) => (
        <div key={label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
            <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg', tone)}>
              <Icon className="h-3.5 w-3.5" />
            </span>
          </div>
          {loading && !stats ? (
            <div className="mt-2 h-7 w-14 rounded bg-slate-100" />
          ) : (
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
              {value.toLocaleString()}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

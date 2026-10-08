import { cn } from '@/lib/utils';
import type { EmailStatus } from '@/lib/types';

const STYLES: Record<EmailStatus, { label: string; className: string; dot: string }> = {
  scheduled: {
    label: 'Scheduled',
    className: 'bg-amber-50 text-amber-700 ring-amber-600/20',
    dot: 'bg-amber-500',
  },
  processing: {
    label: 'Sending',
    className: 'bg-blue-50 text-blue-700 ring-blue-600/20',
    dot: 'bg-blue-500 animate-pulse',
  },
  sent: {
    label: 'Sent',
    className: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    dot: 'bg-emerald-500',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-50 text-red-700 ring-red-600/20',
    dot: 'bg-red-500',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-slate-100 text-slate-600 ring-slate-500/20',
    dot: 'bg-slate-400',
  },
};

export function StatusBadge({ status }: { status: EmailStatus }) {
  const style = STYLES[status] ?? STYLES.scheduled;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        style.className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} aria-hidden />
      {style.label}
    </span>
  );
}

'use client';

import { CalendarClock, ExternalLink, Inbox, Send } from 'lucide-react';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/Feedback';
import { Column, DataTable, Pagination } from '@/components/ui/Table';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { EmailListItem, EmailView, Paginated } from '@/lib/types';
import { formatDateTime, formatRelative } from '@/lib/utils';

export interface EmailTableProps {
  view: EmailView;
  data?: Paginated<EmailListItem>;
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
  page: number;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  onCompose: () => void;
}

/**
 * The Scheduled and Sent tabs share this component — they differ only in which
 * time column they show and what the empty state says, so the columns are built
 * from the `view` rather than duplicating the table.
 */
export function EmailTable({
  view,
  data,
  isLoading,
  isError,
  error,
  page,
  onPageChange,
  onRetry,
  onCompose,
}: EmailTableProps) {
  const columns: Column<EmailListItem>[] = [
    {
      key: 'email',
      header: 'Email',
      className: 'font-medium text-slate-900',
      render: (row) => <span className="block max-w-[260px] truncate">{row.recipientEmail}</span>,
    },
    {
      key: 'subject',
      header: 'Subject',
      render: (row) => <span className="block max-w-[300px] truncate text-slate-600">{row.subject}</span>,
    },
    view === 'scheduled'
      ? {
          key: 'scheduledAt',
          header: 'Scheduled time',
          render: (row) => (
            <div className="whitespace-nowrap">
              <p className="text-slate-700">{formatDateTime(row.scheduledAt)}</p>
              <p className="text-xs text-slate-400">{formatRelative(row.scheduledAt)}</p>
            </div>
          ),
        }
      : {
          key: 'sentAt',
          header: 'Sent time',
          render: (row) => (
            <div className="whitespace-nowrap">
              <p className="text-slate-700">{formatDateTime(row.sentAt)}</p>
              <p className="text-xs text-slate-400">{formatRelative(row.sentAt)}</p>
            </div>
          ),
        },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div className="flex items-center gap-2">
          <StatusBadge status={row.status} />
          {row.status === 'failed' && row.lastError && (
            <span className="max-w-[180px] truncate text-xs text-red-500" title={row.lastError}>
              {row.lastError}
            </span>
          )}
          {row.previewUrl && (
            <a
              href={row.previewUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              View <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      ),
    },
  ];

  if (isLoading && !data) {
    return <TableSkeleton rows={6} columns={4} />;
  }

  if (isError) {
    return <ErrorState message={error?.message ?? 'Could not load emails.'} onRetry={onRetry} />;
  }

  if (!data || data.items.length === 0) {
    return view === 'scheduled' ? (
      <EmptyState
        icon={<CalendarClock className="h-5 w-5" />}
        title="No scheduled emails"
        description="Nothing is queued right now. Compose a campaign and upload your leads to get started."
        action={
          <button
            type="button"
            onClick={onCompose}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
          >
            <Send className="h-4 w-4" />
            Compose New Email
          </button>
        }
      />
    ) : (
      <EmptyState
        icon={<Inbox className="h-5 w-5" />}
        title="No sent emails yet"
        description="Once your scheduled emails start going out, they'll appear here with their delivery status."
      />
    );
  }

  return (
    <>
      <DataTable columns={columns} rows={data.items} rowKey={(row) => row.id} />
      <Pagination
        page={page}
        totalPages={data.totalPages}
        total={data.total}
        pageSize={data.pageSize}
        onPageChange={onPageChange}
      />
    </>
  );
}

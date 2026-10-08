import clsx, { type ClassValue } from 'clsx';
import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/** All timestamps cross the wire as UTC ISO strings and are rendered in local time. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = parseISO(iso);
  if (!isValid(date)) return '—';
  return format(date, 'd MMM yyyy, HH:mm:ss');
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const date = parseISO(iso);
  if (!isValid(date)) return '—';
  const diff = date.getTime() - Date.now();
  const distance = formatDistanceToNowStrict(date);
  return diff > 0 ? `in ${distance}` : `${distance} ago`;
}

/** Turns 2000 into "2s", 90000 into "1m 30s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** `datetime-local` inputs want "YYYY-MM-DDTHH:mm" in local time, not an ISO UTC string. */
export function toLocalDateTimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export const initialsOf = (name: string | null, email: string): string => {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] ?? '?').concat(parts[1]?.[0] ?? '').toUpperCase();
};

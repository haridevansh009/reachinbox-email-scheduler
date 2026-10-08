import { HOUR_MS } from '../config/env';

export interface PlanInput {
  startAt: Date;
  totalRecipients: number;
  minDelayMs: number;
  /** Per-sender hourly cap. */
  hourlyLimit: number;
  /** Number of active senders the campaign will round-robin across. */
  senderCount: number;
}

/**
 * Computes the planned send time for the recipient at `index`.
 *
 * The naive approach — give every job the same delay and let the rate limiter
 * sort it out — means 1000 jobs stampede the worker at T, 995 bounce off the
 * limiter, get requeued, and bounce again. Ordering is destroyed and Redis churns.
 *
 * Instead we lay the sends out at enqueue time. Recipients are round-robined
 * across `senderCount` senders, so each sender gets every Nth recipient and can
 * run its own hourly budget independently. Within one sender the sends are
 * spaced `minDelayMs` apart, and every `hourlyLimit` sends we roll into the
 * next hour window.
 *
 * The Redis limiter then only ever fires as a safety net — for a second campaign
 * competing for the same sender, a backlog after downtime, or two API replicas
 * enqueueing concurrently.
 */
export function plannedOffsetMs(index: number, input: PlanInput): number {
  const { minDelayMs, hourlyLimit, senderCount } = input;

  // Position of this recipient within its own sender's private stream.
  const slotOnSender = Math.floor(index / Math.max(1, senderCount));

  const hourIndex = Math.floor(slotOnSender / hourlyLimit);
  const slotInHour = slotOnSender % hourlyLimit;

  const withinHourMs = slotInHour * minDelayMs;

  // If minDelay * hourlyLimit exceeds an hour, spacing (not the cap) is the
  // binding constraint; fall through to pure spacing so we never schedule
  // two sends for the same instant.
  if (hourlyLimit * minDelayMs >= HOUR_MS) {
    return slotOnSender * minDelayMs;
  }

  return hourIndex * HOUR_MS + withinHourMs;
}

export function plannedSendTime(index: number, input: PlanInput): Date {
  return new Date(input.startAt.getTime() + plannedOffsetMs(index, input));
}

/** Planned send time of the final recipient — shown in the UI as "finishes by". */
export function plannedEndAt(input: PlanInput): Date {
  if (input.totalRecipients <= 0) return input.startAt;
  return plannedSendTime(input.totalRecipients - 1, input);
}

/**
 * Where a rate-limited job should be re-scheduled to.
 *
 * A `quota` rejection means the sender's hour is full. Rescheduling every job to
 * the exact window boundary would make them all wake at once and thrash again,
 * so we re-lay them `minDelayMs` apart in their original CSV order — which is how
 * ordering survives a rate-limit bounce.
 *
 * A `gap` rejection is a sub-second wait; a small pad avoids a tight re-check loop.
 */
export function rescheduleDelayMs(opts: {
  reason: 'gap' | 'quota';
  retryAfterMs: number;
  sequenceIndex: number;
  hourlyLimit: number;
  minDelayMs: number;
}): number {
  if (opts.reason === 'gap') {
    return opts.retryAfterMs + 50;
  }
  const slotInNextWindow = opts.sequenceIndex % opts.hourlyLimit;
  return opts.retryAfterMs + slotInNextWindow * opts.minDelayMs + 100;
}

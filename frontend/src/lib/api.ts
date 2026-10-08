import type {
  ComposePayload,
  CreateCampaignResponse,
  EmailListItem,
  EmailStats,
  EmailView,
  LeadPreview,
  Paginated,
  SendersResponse,
} from './types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions {
  token: string;
  method?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Single fetch wrapper for every backend call. Attaches the session JWT,
 * normalises error shapes, and keeps `fetch` out of the components.
 */
async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...options.headers,
    },
    body: options.body,
    signal: options.signal,
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* response had no JSON body */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listEmails: (
    token: string,
    params: { view: EmailView; page: number; pageSize: number },
  ): Promise<Paginated<EmailListItem>> => {
    const query = new URLSearchParams({
      status: params.view,
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    return request(`/api/emails?${query}`, { token });
  },

  stats: (token: string): Promise<EmailStats> => request('/api/emails/stats', { token }),

  senders: (token: string): Promise<SendersResponse> => request('/api/senders', { token }),

  /** Parse-only: returns how many addresses the backend found, before scheduling. */
  previewLeads: (token: string, file: File): Promise<LeadPreview> => {
    const form = new FormData();
    form.append('file', file);
    return request('/api/campaigns/preview', { token, method: 'POST', body: form });
  },

  createCampaign: (token: string, payload: ComposePayload): Promise<CreateCampaignResponse> => {
    const form = new FormData();
    form.append('subject', payload.subject);
    form.append('body', payload.body);
    form.append('file', payload.file);
    form.append('startAt', payload.startAt);
    form.append('minDelayMs', String(payload.minDelayMs));
    form.append('hourlyLimit', String(payload.hourlyLimit));
    return request('/api/campaigns', { token, method: 'POST', body: form });
  },
};

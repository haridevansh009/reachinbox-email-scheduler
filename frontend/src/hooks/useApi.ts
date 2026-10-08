'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { api } from '@/lib/api';
import type { ComposePayload, EmailView } from '@/lib/types';

/** The backend JWT minted during sign-in. Every query below is gated on it. */
export function useBackendToken(): string | undefined {
  const { data: session } = useSession();
  return session?.backendToken;
}

export const queryKeys = {
  emails: (view: EmailView, page: number) => ['emails', view, page] as const,
  stats: () => ['stats'] as const,
  senders: () => ['senders'] as const,
};

const PAGE_SIZE = 25;

export function useEmails(view: EmailView, page: number) {
  const token = useBackendToken();

  return useQuery({
    queryKey: queryKeys.emails(view, page),
    queryFn: () => api.listEmails(token!, { view, page, pageSize: PAGE_SIZE }),
    enabled: Boolean(token),
    // Rows move scheduled -> sent on their own, so the table polls rather than
    // waiting for the user to refresh.
    refetchInterval: 5_000,
    placeholderData: (previous) => previous,
  });
}

export function useStats() {
  const token = useBackendToken();

  return useQuery({
    queryKey: queryKeys.stats(),
    queryFn: () => api.stats(token!),
    enabled: Boolean(token),
    refetchInterval: 5_000,
  });
}

export function useSenders() {
  const token = useBackendToken();

  return useQuery({
    queryKey: queryKeys.senders(),
    queryFn: () => api.senders(token!),
    enabled: Boolean(token),
    refetchInterval: 15_000,
  });
}

export function useCreateCampaign() {
  const token = useBackendToken();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: ComposePayload) => api.createCampaign(token!, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['emails'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats() });
    },
  });
}

export function usePreviewLeads() {
  const token = useBackendToken();

  return useMutation({
    mutationFn: (file: File) => api.previewLeads(token!, file),
  });
}

export const EMAILS_PAGE_SIZE = PAGE_SIZE;

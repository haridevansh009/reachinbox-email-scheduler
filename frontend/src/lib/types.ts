/** Shared API contract types. Mirror the backend DTOs one-for-one. */

export type EmailStatus = 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled';
export type EmailView = 'scheduled' | 'sent';
export type CampaignStatus = 'building' | 'scheduled' | 'completed' | 'cancelled';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface EmailListItem {
  id: string;
  campaignId: string;
  recipientEmail: string;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  senderId: string;
  attemptCount: number;
  lastError: string | null;
  previewUrl: string | null;
  sequenceIndex: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface EmailStats {
  byStatus: Record<EmailStatus, number>;
  totalCampaigns: number;
  pending: number;
  completed: number;
}

export interface Sender {
  id: string;
  label: string;
  fromEmail: string;
  fromName: string;
  isActive: boolean;
  hourlyLimit: number;
  usedThisHour: number;
}

export interface SchedulerConfig {
  minDelayMs: number;
  hourlyLimitPerSender: number;
  hourlyLimitCeiling: number;
  minDelayFloorMs: number;
  workerConcurrency: number;
  dryRun: boolean;
}

export interface SendersResponse {
  items: Sender[];
  config: SchedulerConfig;
}

export interface Campaign {
  id: string;
  subject: string;
  status: CampaignStatus;
  totalRecipients: number;
  minDelayMs: number;
  hourlyLimit: number;
  startAt: string;
  plannedEndAt: string | null;
  createdAt: string;
}

export interface CreateCampaignResponse {
  campaign: Campaign;
  senderCount: number;
  message: string;
}

export interface LeadPreview {
  count: number;
  totalFound: number;
  duplicatesRemoved: number;
  invalidRows: number;
  sample: string[];
}

export interface ComposePayload {
  subject: string;
  body: string;
  file: File;
  startAt: string;
  minDelayMs: number;
  hourlyLimit: number;
}

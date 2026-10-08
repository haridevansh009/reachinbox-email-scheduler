'use client';

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Info, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { FileDropzone } from '@/components/ui/FileDropzone';
import { Modal } from '@/components/ui/Modal';
import { useCreateCampaign, usePreviewLeads, useSenders } from '@/hooks/useApi';
import { parseLeadsLocally } from '@/lib/csv';
import type { SchedulerConfig } from '@/lib/types';
import { formatDuration, toLocalDateTimeValue } from '@/lib/utils';

interface FormState {
  subject: string;
  body: string;
  startAt: string;
  delaySeconds: number;
  hourlyLimit: number;
}

const emptyForm = (config?: SchedulerConfig): FormState => ({
  subject: '',
  body: '',
  // Default to a minute out so the user has time to review before the first send.
  startAt: toLocalDateTimeValue(new Date(Date.now() + 60_000)),
  delaySeconds: Math.round((config?.minDelayMs ?? 2000) / 1000),
  hourlyLimit: config?.hourlyLimitPerSender ?? 200,
});

export function ComposeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: sendersData } = useSenders();
  const config = sendersData?.config;

  const [form, setForm] = useState<FormState>(emptyForm());
  const [file, setFile] = useState<File | null>(null);
  const [detectedCount, setDetectedCount] = useState<number | null>(null);
  const [parsing, setParsing] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState | 'file', string>>>({});

  const createCampaign = useCreateCampaign();
  const previewLeads = usePreviewLeads();

  // Reset to defaults each time the modal opens, using the live server config.
  useEffect(() => {
    if (open) {
      setForm(emptyForm(config));
      setFile(null);
      setDetectedCount(null);
      setErrors({});
    }
  }, [open, config]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const handleFile = async (next: File | null) => {
    setFile(next);
    setDetectedCount(null);
    setErrors((prev) => ({ ...prev, file: undefined }));
    if (!next) return;

    setParsing(true);
    try {
      // Parse locally for an instant count, then confirm with the backend so the
      // number shown is exactly what will be scheduled.
      const local = await parseLeadsLocally(next);
      setDetectedCount(local.emails.length);

      const server = await previewLeads.mutateAsync(next);
      setDetectedCount(server.count);

      if (server.count === 0) {
        setErrors((prev) => ({ ...prev, file: 'No valid email addresses found in this file.' }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read that file.';
      setErrors((prev) => ({ ...prev, file: message }));
    } finally {
      setParsing(false);
    }
  };

  const validate = (): boolean => {
    const next: typeof errors = {};
    if (!form.subject.trim()) next.subject = 'Subject is required.';
    if (!form.body.trim()) next.body = 'Body is required.';
    if (!file) next.file = 'Upload a CSV or TXT file of leads.';
    else if (detectedCount === 0) next.file = 'No valid email addresses found in this file.';
    if (!form.startAt) next.startAt = 'Pick a start time.';

    const minDelaySeconds = Math.ceil((config?.minDelayFloorMs ?? 1000) / 1000);
    if (form.delaySeconds < minDelaySeconds) {
      next.delaySeconds = `Minimum is ${minDelaySeconds}s.`;
    }
    if (form.hourlyLimit < 1) next.hourlyLimit = 'Must be at least 1.';

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate() || !file) return;

    try {
      const result = await createCampaign.mutateAsync({
        subject: form.subject.trim(),
        body: form.body.trim(),
        file,
        // `datetime-local` is local time; convert to UTC ISO for the API.
        startAt: new Date(form.startAt).toISOString(),
        minDelayMs: form.delaySeconds * 1000,
        hourlyLimit: form.hourlyLimit,
      });

      toast.success(result.message);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to schedule campaign.');
    }
  };

  const senderCount = sendersData?.items.length ?? 0;

  const throughputNote = useMemo(() => {
    if (!senderCount || !detectedCount) return null;
    const perHour = senderCount * form.hourlyLimit;
    const hours = detectedCount / perHour;
    const spacingHours = (detectedCount * form.delaySeconds) / (senderCount * 3600);
    const estimate = Math.max(hours, spacingHours);

    return `${detectedCount.toLocaleString()} emails across ${senderCount} sender${
      senderCount === 1 ? '' : 's'
    } — about ${perHour.toLocaleString()}/hour, finishing in roughly ${
      estimate < 1 ? `${Math.ceil(estimate * 60)} min` : `${estimate.toFixed(1)} h`
    }.`;
  }, [senderCount, detectedCount, form.hourlyLimit, form.delaySeconds]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Compose New Email"
      description="Upload your leads, set the pace, and schedule the campaign."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createCampaign.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            loading={createCampaign.isPending}
            leftIcon={<Send className="h-4 w-4" />}
          >
            {createCampaign.isPending ? 'Scheduling…' : 'Schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Subject" htmlFor="subject" required error={errors.subject}>
          <Input
            id="subject"
            value={form.subject}
            onChange={(e) => update('subject', e.target.value)}
            placeholder="Quick question about your outbound process"
            maxLength={500}
          />
        </Field>

        <Field label="Body" htmlFor="body" required error={errors.body}>
          <Textarea
            id="body"
            rows={6}
            value={form.body}
            onChange={(e) => update('body', e.target.value)}
            placeholder={'Hi there,\n\nI noticed your team is scaling outbound…'}
          />
        </Field>

        {/* There is no "To" field: recipients come from the uploaded lead list,
            one email per address, which is how a cold-outreach campaign works. */}
        <Field
          label="Recipients — upload your leads file"
          required
          error={errors.file}
          hint="Every address in this file gets its own scheduled email. CSV or TXT; addresses are detected in any column and duplicates are removed."
        >
          <FileDropzone
            file={file}
            onFileChange={(next) => void handleFile(next)}
            disabled={createCampaign.isPending}
            detail={
              parsing
                ? 'Scanning file…'
                : detectedCount !== null
                  ? `${detectedCount.toLocaleString()} email address${detectedCount === 1 ? '' : 'es'} detected`
                  : undefined
            }
            detailTone={detectedCount === 0 ? 'error' : detectedCount ? 'success' : 'neutral'}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Start time" htmlFor="startAt" required error={errors.startAt}>
            <Input
              id="startAt"
              type="datetime-local"
              value={form.startAt}
              onChange={(e) => update('startAt', e.target.value)}
            />
          </Field>

          <Field
            label="Delay between emails"
            htmlFor="delaySeconds"
            error={errors.delaySeconds}
            hint={config ? `Min ${formatDuration(config.minDelayFloorMs)}` : undefined}
          >
            <div className="relative">
              <Input
                id="delaySeconds"
                type="number"
                min={Math.ceil((config?.minDelayFloorMs ?? 1000) / 1000)}
                value={form.delaySeconds}
                onChange={(e) => update('delaySeconds', Number(e.target.value))}
                className="pr-12"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-400">
                sec
              </span>
            </div>
          </Field>

          <Field
            label="Hourly limit"
            htmlFor="hourlyLimit"
            error={errors.hourlyLimit}
            hint={config ? `Max ${config.hourlyLimitCeiling.toLocaleString()} per sender` : undefined}
          >
            <Input
              id="hourlyLimit"
              type="number"
              min={1}
              max={config?.hourlyLimitCeiling}
              value={form.hourlyLimit}
              onChange={(e) => update('hourlyLimit', Number(e.target.value))}
            />
          </Field>
        </div>

        {throughputNote && (
          <div className="flex gap-2.5 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
            <p className="text-xs leading-relaxed text-brand-900">{throughputNote}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';
import { FileText, UploadCloud, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface FileDropzoneProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
  accept?: string;
  /** Rendered under the filename once a file is selected, e.g. "412 emails detected". */
  detail?: string;
  detailTone?: 'neutral' | 'success' | 'error';
  disabled?: boolean;
}

export function FileDropzone({
  file,
  onFileChange,
  accept = '.csv,.txt,text/csv,text/plain',
  detail,
  detailTone = 'neutral',
  disabled,
}: FileDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;
      const dropped = event.dataTransfer.files?.[0];
      if (dropped) onFileChange(dropped);
    },
    [disabled, onFileChange],
  );

  if (file) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-brand-600 ring-1 ring-slate-200">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">{file.name}</p>
          {detail && (
            <p
              className={cn(
                'text-xs',
                detailTone === 'success' && 'text-emerald-600',
                detailTone === 'error' && 'text-red-600',
                detailTone === 'neutral' && 'text-slate-500',
              )}
            >
              {detail}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            onFileChange(null);
            if (inputRef.current) inputRef.current.value = '';
          }}
          aria-label="Remove file"
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white hover:text-slate-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors',
        dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <UploadCloud className={cn('mb-2 h-6 w-6', dragging ? 'text-brand-600' : 'text-slate-400')} />
      <p className="text-sm font-medium text-slate-700">
        Drop your leads file, or <span className="text-brand-600">browse</span>
      </p>
      <p className="mt-0.5 text-xs text-slate-500">CSV or TXT — addresses can be in any column</p>

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

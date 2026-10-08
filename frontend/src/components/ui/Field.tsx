'use client';

import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const CONTROL = cn(
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900',
  'ring-1 ring-inset ring-slate-300 placeholder:text-slate-400',
  'focus:ring-2 focus:ring-inset focus:ring-brand-600',
  'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500',
);

export interface FieldWrapperProps {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/** Shared label / hint / error chrome so every control renders identically. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: FieldWrapperProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(CONTROL, className)} {...props} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(CONTROL, 'resize-y', className)} {...props} />;
  },
);

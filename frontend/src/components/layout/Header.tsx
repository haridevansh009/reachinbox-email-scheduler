'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { signOut, useSession } from 'next-auth/react';
import { ChevronDown, LogOut, Mail } from 'lucide-react';
import { initialsOf } from '@/lib/utils';

export function Header() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the menu on any outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const user = session?.user;
  const name = user?.name ?? null;
  const email = user?.email ?? '';

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600">
            <Mail className="h-4 w-4 text-white" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-slate-900">ReachInbox</p>
            <p className="hidden text-xs text-slate-500 sm:block">Email Scheduler</p>
          </div>
        </div>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            className="flex items-center gap-2.5 rounded-lg py-1.5 pl-1.5 pr-2 transition-colors hover:bg-slate-100"
          >
            <Avatar src={user?.image ?? null} name={name} email={email} />
            <span className="hidden text-left sm:block">
              <span className="block max-w-[160px] truncate text-sm font-medium text-slate-900">
                {name ?? 'Signed in'}
              </span>
              <span className="block max-w-[160px] truncate text-xs text-slate-500">{email}</span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
          </button>

          {open && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-60 animate-scale-in overflow-hidden rounded-xl border border-slate-200 bg-white shadow-pop"
            >
              <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
                <Avatar src={user?.image ?? null} name={name} email={email} size={36} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">{name ?? 'Signed in'}</p>
                  <p className="truncate text-xs text-slate-500">{email}</p>
                </div>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => void signOut({ callbackUrl: '/login' })}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50"
              >
                <LogOut className="h-4 w-4 text-slate-400" />
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function Avatar({
  src,
  name,
  email,
  size = 32,
}: {
  src: string | null;
  name: string | null;
  email: string;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);

  if (src && !errored) {
    return (
      <Image
        src={src}
        alt={name ?? email}
        width={size}
        height={size}
        className="shrink-0 rounded-full ring-1 ring-slate-200"
        onError={() => setErrored(true)}
        unoptimized
      />
    );
  }

  return (
    <span
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700"
    >
      {initialsOf(name, email)}
    </span>
  );
}

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { buyer, publisher } from '@/lib/mock';
import { DataModeSwitch } from './DataModeSwitch';
import { cx } from './ui';

const NAV = {
  publisher: [
    { href: '/publisher/earnings', label: 'Earnings' },
    { href: '/publisher/sources', label: 'Sources' },
    { href: '/publisher/licence', label: 'Licence' },
    { href: '/publisher/content', label: 'Content' },
  ],
  buyer: [
    { href: '/buyer/playground', label: 'Playground' },
    { href: '/buyer/keys', label: 'API keys & MCP' },
    { href: '/buyer/usage', label: 'Usage' },
  ],
} as const;

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-9 place-items-center rounded-lg bg-brand" aria-hidden="true">
        <svg viewBox="0 0 20 20" className="size-5 text-white">
          <path d="M5 6h10M5 10h10M5 14h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="font-display text-[22px] font-semibold tracking-tight">FairSource</span>
    </div>
  );
}

function RoleSwitch({ role }: { role: 'publisher' | 'buyer' }) {
  return (
    <div className="grid grid-cols-2 rounded-xl bg-side-raised p-1" role="tablist" aria-label="View as">
      {(['publisher', 'buyer'] as const).map((r) => (
        <Link
          key={r}
          href={NAV[r][0].href}
          role="tab"
          aria-selected={role === r}
          className={cx(
            'rounded-lg px-3 py-2.5 text-center text-[15px] font-semibold capitalize transition-colors',
            role === r ? 'bg-white text-ink' : 'text-side-muted hover:text-white',
          )}
        >
          {r}
        </Link>
      ))}
    </div>
  );
}

export interface ShellIdentity {
  role: 'publisher' | 'buyer';
  org: { name: string; subtitle: string };
}

export function ExternalIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d="M9 3h4v4M13 3L7 9M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The API reference opens in a new tab. */
function DocsLink({ mobile }: { mobile: boolean }) {
  return (
    <a
      href="/docs"
      target="_blank"
      rel="noopener noreferrer"
      className={cx(
        'inline-flex items-center gap-2 rounded-lg text-white/80 transition-colors hover:bg-white/5 hover:text-white',
        mobile ? 'px-3 py-2 text-[15px] whitespace-nowrap' : 'px-4 py-2.5 text-[16px]',
      )}
    >
      API docs
      <ExternalIcon />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function SignOut() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="mt-3 text-sm text-side-muted underline-offset-4 hover:text-white hover:underline"
      onClick={async () => {
        await fetch('/api/session', { method: 'DELETE' });
        router.replace('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

/**
 * Demo mode (identity null, live false): both roles with a Publisher/Buyer switch.
 * Live mode: only the signed-in organisation's pages, its real name, and sign out.
 */
export function Shell({ children, identity, live, modeSwitch }: { children: ReactNode; identity: ShellIdentity | null; live: boolean; modeSwitch: boolean }) {
  const path = usePathname() ?? '';
  if (path === '/login' || (live && !identity)) {
    return <main className="min-h-screen px-4 py-8 sm:px-8">{children}</main>;
  }
  const role: 'publisher' | 'buyer' = identity?.role ?? (path.startsWith('/buyer') ? 'buyer' : 'publisher');
  const org = identity?.org ?? (role === 'buyer' ? buyer : publisher);
  const nav = NAV[role];

  const links = (mobile: boolean) =>
    nav.map((n) => {
      const active = path.startsWith(n.href);
      return (
        <Link
          key={n.href}
          href={n.href}
          aria-current={active ? 'page' : undefined}
          className={cx(
            'rounded-lg px-4 py-2.5 text-[16px] whitespace-nowrap transition-colors',
            active ? 'bg-side-raised font-semibold text-white' : 'text-white/80 hover:bg-white/5 hover:text-white',
            mobile && 'px-3 py-2 text-[15px]',
          )}
        >
          {n.label}
        </Link>
      );
    });

  return (
    <div className="min-h-screen md:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col bg-side px-5 py-8 text-white md:flex">
        <Logo />
        {modeSwitch && (
          <div className="mt-6 px-1">
            <DataModeSwitch live={live} />
          </div>
        )}
        {!identity && (
          <div className="mt-5">
            <RoleSwitch role={role} />
          </div>
        )}
        <div className="mt-9 px-4 text-xs font-medium tracking-[0.12em] text-side-muted uppercase">{role}</div>
        <nav className="mt-3 flex flex-col gap-1" aria-label={`${role} pages`}>
          {links(false)}
          {role === 'buyer' && <DocsLink mobile={false} />}
        </nav>
        <div className="mt-auto border-t border-white/10 px-4 pt-5">
          <div className="font-semibold">{org.name}</div>
          <div className="mt-1 text-sm text-side-muted">{org.subtitle}</div>
          {identity && <SignOut />}
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="bg-side px-4 pt-4 pb-3 text-white md:hidden">
        <div className="flex items-center justify-between gap-3">
          <Logo />
          {!identity && (
            <div className="w-[164px] shrink-0 [&_a]:px-2 [&_a]:py-2 [&_a]:text-sm">
              <RoleSwitch role={role} />
            </div>
          )}
        </div>
        {modeSwitch && (
          <div className="mt-3 max-w-[220px]">
            <DataModeSwitch live={live} />
          </div>
        )}
        <nav className="-mx-1 mt-3 flex gap-1 overflow-x-auto px-1" aria-label={`${role} pages`}>
          {links(true)}
          {role === 'buyer' && <DocsLink mobile />}
        </nav>
      </div>

      <main className="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-12 lg:py-11">
        <div className="mx-auto max-w-[1440px]">{children}</div>
      </main>
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { setDataMode } from '@/app/mode-actions';
import { cx } from './ui';

/** Demo data / Live data. Live needs the Firebase project and a sign-in. */
export function DataModeSwitch({ live, tone = 'dark' }: { live: boolean; tone?: 'dark' | 'light' }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const choose = (mode: 'demo' | 'live') => {
    if ((mode === 'live') === live || pending) return;
    start(async () => {
      await setDataMode(mode);
      router.push('/');
      router.refresh();
    });
  };

  const dark = tone === 'dark';
  return (
    <div className={cx('flex items-center gap-2', pending && 'opacity-60')}>
      <span className={cx('text-xs font-medium tracking-[0.08em] uppercase', dark ? 'text-side-muted' : 'text-muted')}>Data</span>
      <div role="radiogroup" aria-label="Data shown" className={cx('grid flex-1 grid-cols-2 rounded-lg p-0.5', dark ? 'bg-side-raised' : 'border border-line bg-subtle')}>
        {(['demo', 'live'] as const).map((m) => {
          const active = (m === 'live') === live;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={pending}
              onClick={() => choose(m)}
              className={cx(
                'flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-semibold transition-colors',
                active ? (dark ? 'bg-white/90 text-ink' : 'bg-white text-ink shadow-sm') : dark ? 'text-side-muted hover:text-white' : 'text-muted hover:text-ink',
              )}
            >
              {m === 'live' && <span className={cx('size-1.5 rounded-full', active ? 'bg-good' : 'bg-current opacity-60')} aria-hidden="true" />}
              {m === 'demo' ? 'Demo' : 'Live'}
            </button>
          );
        })}
      </div>
    </div>
  );
}

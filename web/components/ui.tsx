// Presentational building blocks shared by every screen. No hooks here, so these
// work in both server and client components.

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export function PageHeader({ title, description, actions }: { title: string; description: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-display text-[34px] leading-tight font-semibold tracking-tight sm:text-[40px]">{title}</h1>
        <p className="mt-1.5 text-[15px] text-muted">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}

export function Card({ children, className, dark }: { children: ReactNode; className?: string; dark?: boolean }) {
  return (
    <section
      className={cx(
        'min-w-0 rounded-2xl p-5 sm:p-7',
        dark ? 'bg-panel text-white' : 'border border-line bg-card',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-5 flex items-baseline justify-between gap-4">
      <h2 className="font-display text-xl font-semibold">{children}</h2>
      {aside && <div className="text-sm text-muted">{aside}</div>}
    </div>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'brand';

const PILL: Record<Tone, string> = {
  good: 'bg-good-tint text-good',
  warn: 'bg-warn-tint text-warn',
  bad: 'bg-bad-tint text-bad',
  neutral: 'bg-neutral-tint text-[#4a4a50]',
  brand: 'bg-brand-tint text-brand',
};

export function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-medium whitespace-nowrap', PILL[tone], className)}>
      {children}
    </span>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'dark';

const BUTTON: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover disabled:bg-brand/50',
  secondary: 'border border-line bg-card text-ink hover:bg-subtle disabled:text-muted',
  danger: 'border border-bad/30 bg-card text-bad hover:bg-bad-tint',
  dark: 'border border-white/15 bg-panel-raised text-white hover:bg-white/10',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed',
        size === 'md' ? 'px-5 py-3 text-[15px]' : 'px-3.5 py-2 text-sm',
        BUTTON[variant],
        className,
      )}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cx(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-brand' : 'bg-toggle-off',
      )}
    >
      <span
        className={cx(
          'inline-block size-5.5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[23px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  dark,
  label,
}: {
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  dark?: boolean;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx('inline-flex rounded-xl p-1', dark ? 'bg-panel-raised' : 'border border-line bg-subtle')}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cx(
              'rounded-lg px-4 py-2 text-[15px] font-semibold transition-colors',
              active
                ? dark
                  ? 'bg-white text-ink'
                  : 'bg-white text-ink shadow-sm'
                : dark
                  ? 'text-panel-muted hover:text-white'
                  : 'text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function StatTile({ label, value, sub, valueClass, children }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-card p-6">
      <div className="text-[15px] text-muted">{label}</div>
      <div className={cx('mt-3 font-display text-[34px] leading-none font-semibold tracking-tight tabular', valueClass)}>{value}</div>
      {children}
      {sub && <div className="mt-3 text-sm text-muted">{sub}</div>}
    </div>
  );
}

/** Horizontal meter with a label and value above it. */
export function Meter({ label, value, pct, tone = 'brand', mono }: { label: string; value: string; pct: number; tone?: 'brand' | 'good'; mono?: boolean }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-4 text-[15px]">
        <span className={cx(mono && 'font-mono')}>{label}</span>
        <span className="text-muted tabular">{value}</span>
      </div>
      <div className="h-2.5 rounded-full bg-neutral-tint" role="presentation">
        <div className={cx('h-full rounded-full', tone === 'brand' ? 'bg-brand' : 'bg-good')} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cx('pb-3 text-left text-[14px] font-normal text-muted', className)}>{children}</th>;
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx('py-4 align-middle', className)}>{children}</td>;
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <path d="M5 10.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

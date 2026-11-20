'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart } from '@/components/BarChart';
import { Button, Card, CardTitle, PageHeader, Pill, Segmented, StatTile, Td, Th, cx } from '@/components/ui';
import type { getEarnings } from '@/lib/data';
import { clock, compact, costOf, dayMonth, int, usd } from '@/lib/format';
import type { UseEvent } from '@/lib/mock';

type Props = Awaited<ReturnType<typeof getEarnings>>;

/** Demo mode: a new licensed use arrives every few seconds. */
const DEMO_INTERVAL_MS = 4500;
/** Live mode: the page re-reads the counters this often. */
const REFRESH_MS = 5000;

export function EarningsView({ today, month, daily, recentUses, topArticles, payout, pricePer1k, share, licenceVersion, live = false }: Props & { live?: boolean }) {
  const router = useRouter();
  const [range, setRange] = useState<'7' | '30'>('30');
  const [uses, setUses] = useState<UseEvent[]>(recentUses);
  const [added, setAdded] = useState({ share: 0, tokens: 0, count: 0 });
  const seq = useRef(0);

  const shareOf = (tokens: number) => costOf(tokens, pricePer1k) * share;

  useEffect(() => {
    if (live) {
      const id = setInterval(() => router.refresh(), REFRESH_MS);
      return () => clearInterval(id);
    }
    const templates = recentUses;
    if (!templates.length) return;
    const id = setInterval(() => {
      const t = templates[Math.floor(Math.random() * templates.length)]!;
      seq.current += 1;
      const ev: UseEvent = { ...t, id: `live-${seq.current}`, time: clock(new Date()) };
      setUses((prev) => [ev, ...prev].slice(0, 5));
      setAdded((a) => ({
        share: a.share + shareOf(t.tokens),
        tokens: a.tokens + t.tokens,
        count: a.count + 1,
      }));
    }, DEMO_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const todayShare = today.shareUSD + added.share;
  const shown = live ? recentUses : uses;
  const latest = shown[0];

  const chartDays = useMemo(() => {
    const days = daily.map((d, i) => (i === daily.length - 1 ? { ...d, value: d.value + added.share } : d));
    return range === '7' ? days.slice(-7) : days;
  }, [daily, range, added.share]);

  const peak = daily.slice(0, -1).reduce((a, b) => (b.value > a.value ? b : a), daily[0]!);
  const tickEvery = range === '7' ? 1 : 7;
  const ticks = chartDays
    .map((d, i) => ({ index: i, label: i === chartDays.length - 1 ? 'Today' : dayMonth(d.date) }))
    .filter((t, i, all) => i === all.length - 1 || (i % tickEvery === 0 && all.length - 1 - i >= tickEvery / 2));

  function downloadStatement() {
    const header = ['Article', 'Language', 'Uses', 'Tokens', 'Gross (USD)', `Your share ${Math.round(share * 100)}% (USD)`];
    const lines = topArticles.map((a) => {
      const gross = costOf(a.tokens, pricePer1k);
      return [a.title, a.language, a.uses, a.tokens, gross.toFixed(4), (gross * share).toFixed(4)];
    });
    const csv = [header, ...lines].map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'fairsource-statement-2026-11.csv' });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Earnings"
        description="Every licensed use of your content, metered and credited. Payouts run on the 3rd of each month."
        actions={
          <>
            <Segmented
              label="Chart range"
              value={range}
              onChange={setRange}
              options={[
                { value: '7', label: '7 days' },
                { value: '30', label: '30 days' },
              ]}
            />
            <Button variant="secondary" onClick={downloadStatement}>
              <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
                <path d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Download statement
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        <Card dark className="flex flex-col">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[17px] text-white/85">Earned today · your {Math.round(share * 100)}% share</span>
            <span className="inline-flex items-center gap-2 rounded-full bg-good/25 px-3 py-1 text-sm font-semibold text-good-bright">
              <span className="size-2 animate-pulse rounded-full bg-good-bright" aria-hidden="true" /> Live
            </span>
          </div>
          <div className="mt-6 font-mono text-[56px] leading-none font-semibold tracking-tight tabular sm:text-[76px]" aria-live="polite">
            {usd(todayShare, 4)}
          </div>
          <dl className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-3">
            <div>
              <dt className="sr-only">Tokens served today</dt>
              <dd className="font-display text-2xl font-semibold tabular">{int(today.tokens + added.tokens)}</dd>
              <dd className="text-[15px] text-white/70">tokens served today</dd>
            </div>
            <div>
              <dt className="sr-only">Licensed uses</dt>
              <dd className="font-display text-2xl font-semibold tabular">{int(today.uses + added.count)}</dd>
              <dd className="text-[15px] text-white/70">licensed uses</dd>
            </div>
            <div>
              <dt className="sr-only">Price</dt>
              <dd className="font-display text-2xl font-semibold tabular">{usd(pricePer1k, 3)}</dd>
              <dd className="text-[15px] text-white/70">per 1,000 tokens · licence v{licenceVersion}</dd>
            </div>
          </dl>
          <div key={latest?.id ?? 'none'} className="mt-8 rounded-xl bg-panel-raised px-5 py-4 text-[15px]">
            <div className="text-sm text-white/60">Latest</div>
            <div className="mt-1.5 leading-relaxed">
              {latest ? (
                <>
                  {latest.title} · {latest.buyer} · {latest.endpoint} · {int(latest.tokens)} tokens ·{' '}
                  <span className="text-good-bright">+{usd(shareOf(latest.tokens), 4)}</span>
                </>
              ) : (
                'No licensed uses yet. They appear here within seconds of a buyer’s request.'
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle aside={<Link href="/publisher/content" className="font-medium text-brand underline underline-offset-4">View content</Link>}>
            Recent uses
          </CardTitle>
          <ol className="flex flex-col gap-1">
            {shown.length === 0 && <li className="px-3 py-3 text-muted">No uses yet.</li>}
            {shown.map((u, i) => (
              <li key={u.id} className={cx('grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-xl px-3 py-3', i === 0 && 'flash-in bg-brand-tint/60')}>
                <span className="font-mono text-sm text-muted tabular">{u.time}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[16px]">{u.title}</span>
                  <span className="block text-sm text-muted">
                    {u.buyer} · {u.endpoint} · {int(u.tokens)} tokens
                  </span>
                </span>
                <span className="font-mono text-[15px] text-good tabular">+{usd(shareOf(u.tokens), 4)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Gross this month" value={usd(month.gross)} sub="1–18 Nov" />
        <StatTile label={`Your share (${Math.round(share * 100)}%)`} value={usd(month.share)} valueClass="text-good" sub="Credited from the usage ledger" />
        <StatTile label="Tokens served" value={compact(month.tokens)} sub="Search, answer and MCP" />
        <StatTile
          label="Articles used"
          value={
            <>
              {int(month.articlesUsed)} <span className="text-xl font-normal text-muted">of {int(month.articlesTotal)}</span>
            </>
          }
          sub="At least once this month"
        />
      </div>

      <Card className="mt-6">
        <CardTitle aside={`Peak ${usd(peak.value)} on ${dayMonth(peak.date)} · today updates live`}>Daily earnings · your share</CardTitle>
        <BarChart
          label={`Daily earnings, last ${range} days`}
          bars={chartDays.map((d, i) => ({
            key: d.date,
            value: d.value,
            title: `${i === chartDays.length - 1 ? 'Today' : dayMonth(d.date)}: ${usd(d.value)}`,
          }))}
          ticks={ticks}
        />
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.75fr_1fr]">
        <Card>
          <CardTitle>Top articles this month</CardTitle>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead className="border-b border-line">
                <tr>
                  <Th>Article</Th>
                  <Th>Language</Th>
                  <Th className="pl-6 text-right">Uses</Th>
                  <Th className="pl-6 text-right">Tokens</Th>
                  <Th className="pl-6 text-right">Your share</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {topArticles.map((a) => (
                  <tr key={a.title}>
                    <Td className="pr-4">
                      <span className="text-[16px]">{a.title}</span>
                      {'scan' in a && a.scan === true ? <Pill tone="warn" className="ml-2 px-2 py-0.5 text-xs">Scan</Pill> : null}
                    </Td>
                    <Td className="text-muted">{a.language}</Td>
                    <Td className="pl-6 text-right tabular">{int(a.uses)}</Td>
                    <Td className="pl-6 text-right tabular">{compact(a.tokens)}</Td>
                    <Td className="pl-6 text-right font-semibold tabular">{usd(costOf(a.tokens, pricePer1k) * share)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardTitle>Next payout</CardTitle>
          <div className="font-display text-[44px] leading-none font-semibold tracking-tight tabular">{usd(month.share + payout.carried)}</div>
          <div className="mt-3 text-[16px] text-muted">Estimated · paid on {payout.date}</div>
          <dl className="mt-6 flex flex-col gap-3 text-[15px]">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">November share so far</dt>
              <dd className="tabular">{usd(month.share)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Carried from October</dt>
              <dd className="tabular">{usd(payout.carried)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Payout account</dt>
              <dd className="font-medium">{payout.account}</dd>
            </div>
          </dl>
          <p className="mt-6 rounded-xl bg-subtle px-4 py-3.5 text-sm leading-relaxed text-muted">
            October&apos;s balance was under the ${payout.minimum} minimum, so it rolls into this payout. Amounts are computed from the usage ledger, never from the live counter.
          </p>
        </Card>
      </div>
    </>
  );
}

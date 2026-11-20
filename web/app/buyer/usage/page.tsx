import type { Metadata } from 'next';
import { BarChart } from '@/components/BarChart';
import { Button, Card, CardTitle, Meter, PageHeader, StatTile, Td, Th } from '@/components/ui';
import { getUsage } from '@/lib/data';
import { compact, costOf, dayMonth, int, pct, usd } from '@/lib/format';

export const metadata: Metadata = { title: 'Usage' };

export default async function UsagePage() {
  const { usage, quota } = await getUsage();
  const tokens = usage.daily.reduce((n, d) => n + d.tokens, 0);
  const spend = usage.publishers.reduce((n, p) => n + costOf(p.tokens, p.pricePer1k), 0);
  const today = usage.daily.at(-1)!;
  const last = usage.daily.length - 1;
  const quotaPct = pct(tokens, quota);

  return (
    <>
      <PageHeader
        title="Usage"
        description={`${usage.periodLabel}. Billed monthly in arrears; your next invoice is on ${usage.nextInvoice}.`}
        actions={
          <Button variant="secondary" disabled title="Opens the Stripe Billing portal once billing is connected">
            Manage billing
          </Button>
        }
      />

      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Tokens served" value={compact(tokens)} sub={`1–${Number(today.date.slice(-2))} Nov`} />
        <StatTile label="Spend" value={usd(spend)} sub="At publishers' licence prices" />
        <StatTile label="Requests" value={int(usage.requests)} sub={`${usage.rateLimited} rate-limited`} />
        <StatTile label="Monthly quota" value={`${quotaPct}%`} sub={`${compact(tokens)} of ${compact(quota)} tokens`}>
          <div className="mt-4 h-2.5 rounded-full bg-neutral-tint" role="progressbar" aria-valuenow={quotaPct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly quota used">
            <div className="h-full rounded-full bg-brand" style={{ width: `${quotaPct}%` }} />
          </div>
        </StatTile>
      </div>

      <Card className="mt-6">
        <CardTitle aside={`Today so far: ${compact(today.tokens)}`}>Tokens per day</CardTitle>
        <BarChart
          label="Tokens served per day this month"
          bars={usage.daily.map((d, i) => ({ key: d.date, value: d.tokens, title: `${i === last ? 'Today' : dayMonth(d.date)}: ${compact(d.tokens)} tokens` }))}
          ticks={[0, 5, 10].map((i) => ({ index: i, label: dayMonth(usage.daily[i]!.date) })).concat({ index: last, label: 'Today' })}
        />
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>By endpoint</CardTitle>
          <div className="flex flex-col gap-5">
            {usage.byEndpoint.map((e) => (
              <Meter key={e.label} mono label={e.label} value={`${compact(e.tokens)} · ${pct(e.tokens, tokens)}%`} pct={pct(e.tokens, tokens)} />
            ))}
          </div>
        </Card>
        <Card>
          <CardTitle>By content language</CardTitle>
          <div className="flex flex-col gap-5">
            {usage.byLanguage.map((l) => (
              <Meter key={l.label} tone="good" label={l.label} value={`${compact(l.tokens)} · ${pct(l.tokens, tokens)}%`} pct={pct(l.tokens, tokens)} />
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <CardTitle>Publishers you used</CardTitle>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px]">
            <thead className="border-b border-line">
              <tr>
                <Th>Publisher</Th>
                <Th>Licence</Th>
                <Th className="text-right">Price / 1K tokens</Th>
                <Th className="text-right">Tokens</Th>
                <Th className="text-right">Spend</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {usage.publishers.map((p) => (
                <tr key={p.name}>
                  <Td className="text-[16px]">{p.name}</Td>
                  <Td className="font-mono text-[15px]">{p.licence}</Td>
                  <Td className="text-right tabular">{usd(p.pricePer1k, 3)}</Td>
                  <Td className="text-right tabular">{compact(p.tokens)}</Td>
                  <Td className="text-right font-semibold tabular">{usd(costOf(p.tokens, p.pricePer1k))}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { setOptOut as setOptOutAction } from '@/app/actions';
import { Button, Card, Pill, Td, Th, Toggle, cx } from '@/components/ui';
import type { getContent } from '@/lib/data';
import { int } from '@/lib/format';
import type { ContentRow } from '@/lib/mock';
import { documentStatus } from '@/lib/status';

type Props = Awaited<ReturnType<typeof getContent>>;
type Lang = 'All' | ContentRow['language'];

const PAGE_SIZE = 8;

export function ContentView({ rows: initial, totals, live = false }: Props & { live?: boolean }) {
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setRows(initial), [initial]);
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState<Lang>('All');
  const [page, setPage] = useState(0);

  // Opting out or back in changes the publisher-wide servable count.
  const servableDelta = useMemo(
    () =>
      rows.reduce((n, r, i) => {
        const before = documentStatus(initial[i]!).servable;
        const after = documentStatus(r).servable;
        return n + (after === before ? 0 : after ? 1 : -1);
      }, 0),
    [rows, initial],
  );

  const filtered = rows.filter(
    (r) => (lang === 'All' || r.language === lang) && r.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const unfiltered = lang === 'All' && query.trim() === '';
  const totalShown = unfiltered ? totals.documents : filtered.length;
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const hasNext = (page + 1) * PAGE_SIZE < filtered.length;

  const setLocal = (id: string, optOut: boolean) => setRows((all) => all.map((r) => (r.id === id ? { ...r, optOut } : r)));
  async function setOptOut(id: string, optOut: boolean) {
    setLocal(id, optOut); // optimistic
    if (!live) return;
    setError(null);
    const r = await setOptOutAction(id, optOut);
    if (!r.ok) {
      setLocal(id, !optOut);
      setError(r.message);
    }
  }

  return (
    <>
      <header className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="font-display text-[34px] leading-tight font-semibold tracking-tight sm:text-[40px]">Content</h1>
          <p className="mt-1.5 text-[15px] text-muted">
            Everything we hold for you, as AI buyers see it. Opt an article out and it stops appearing on the next request.
          </p>
        </div>
        <dl className="flex shrink-0 gap-8">
          <Stat value={int(totals.documents)} label="documents" />
          <Stat value={int(totals.servable + servableDelta)} label="servable" className="text-good" />
          <Stat value={int(totals.needsReview)} label="need review" className="text-warn" />
        </dl>
      </header>

      <Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <label className="relative block w-full lg:max-w-md">
            <span className="sr-only">Search titles</span>
            <svg viewBox="0 0 20 20" className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted" aria-hidden="true">
              <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              placeholder="Search titles"
              className="w-full rounded-xl border border-line bg-card py-3 pr-4 pl-12 text-[16px] outline-none focus:border-brand"
            />
          </label>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by language">
            {(['All', 'Marathi', 'Hindi', 'English'] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={lang === l}
                onClick={() => {
                  setLang(l);
                  setPage(0);
                }}
                className={cx(
                  'rounded-full border px-5 py-2.5 text-[15px] transition-colors',
                  lang === l ? 'border-ink bg-ink font-semibold text-white' : 'border-line bg-card hover:bg-subtle',
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 text-[15px] text-bad">
            {error}
          </p>
        )}
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="border-b border-line">
              <tr>
                <Th>Title</Th>
                <Th>Language</Th>
                <Th>Type</Th>
                <Th>Published</Th>
                <Th>Status</Th>
                <Th className="text-right">Uses</Th>
                <Th className="pl-6 text-right">Opt out</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {pageRows.map((r) => {
                const s = documentStatus(r);
                const withdrawn = r.status === 'withdrawn';
                return (
                  <tr key={r.id} className={cx(withdrawn && 'text-muted')}>
                    <Td className="pr-6">
                      <div className="text-[16px]">{r.title}</div>
                      <div className="text-sm text-muted">
                        {r.via} · {r.detail}
                        {r.version > 1 && <span className="ml-1.5 font-medium text-brand">· Updated · v{r.version}</span>}
                      </div>
                    </Td>
                    <Td>{r.language}</Td>
                    <Td>{r.type}</Td>
                    <Td className="tabular">{r.published}</Td>
                    <Td className="pr-4">
                      <Pill tone={s.tone}>{s.label}</Pill>
                    </Td>
                    <Td className="text-right tabular" >
                      <span title={withdrawn ? 'Uses before the post was removed. Earnings are kept.' : undefined}>{int(r.uses)}</span>
                    </Td>
                    <Td className="pl-6 text-right">
                      <Toggle
                        label={`Opt out: ${r.title}`}
                        checked={r.optOut}
                        disabled={withdrawn}
                        onChange={(on) => setOptOut(r.id, on)}
                      />
                    </Td>
                  </tr>
                );
              })}
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-muted">
                    No articles match {query ? `“${query}”` : 'this filter'}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-6 flex items-center justify-between gap-4 border-t border-line pt-6">
          <span className="text-[15px] text-muted">
            {filtered.length === 0
              ? 'Showing 0'
              : `Showing ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + pageRows.length} of ${int(totalShown)}`}
          </span>
          <div className="flex gap-3">
            <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="secondary" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

function Stat({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-2 text-[15px] text-muted">{label}</dt>
      <dd className={cx('font-display text-[34px] leading-none font-semibold tabular', className)}>{value}</dd>
    </div>
  );
}

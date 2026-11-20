'use client';

import { useState, type FormEvent } from 'react';
import { playgroundCall } from '@/app/actions';
import { CopyButton } from '@/components/CopyButton';
import { Button, Card, CardTitle, PageHeader, Segmented, cx } from '@/components/ui';
import { API_BASE } from '@/lib/config';
import type { getPlayground } from '@/lib/data';
import { costOf, int, usd } from '@/lib/format';
import type { ChunkResult } from '@/lib/mock';

type Props = Awaited<ReturnType<typeof getPlayground>>;
type Mode = 'search' | 'answer';
type Lang = 'mr' | 'hi' | 'en';

const LANG_NAME: Record<Lang, string> = { mr: 'Marathi', hi: 'Hindi', en: 'English' };

interface CallStats {
  tokens: number;
  cost: number;
  publishers: number;
  latencyMs: number;
}

/** Canned /v1/answer output for the demo question, by answer language. */
const ANSWERS: Record<'en' | 'hi', string> = {
  en: 'The new Pune metro route runs from Hinjewadi to Shivajinagar, and officials say work is in its final stage [1]. It is expected to cut travel time for people working in the IT parks [2]. Some roads in Hinjewadi have been diverted while construction continues [3].',
  hi: 'पुणे मेट्रो का नया मार्ग हिंजवडी से शिवाजीनगर तक है, और अधिकारियों के अनुसार काम अंतिम चरण में है [1]। इससे आईटी पार्क में काम करने वालों का यात्रा समय कम होने की उम्मीद है [2]। निर्माण कार्य के चलते हिंजवडी में कुछ मार्गों पर यातायात बदला गया है [3]।',
};

export function PlaygroundView({ keys, corpus, pricePer1k, live = false }: Props & { live?: boolean }) {
  const [keyPrefix, setKeyPrefix] = useState(keys[0]?.prefix ?? '');
  const [mode, setMode] = useState<Mode>('search');
  const [query, setQuery] = useState('पुणे मेट्रो का नया रूट क्या है?');
  const [langs, setLangs] = useState<Lang[]>(['mr', 'hi']);
  const [limit, setLimit] = useState(5);
  const [answerLang, setAnswerLang] = useState<'en' | 'hi'>('en');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ChunkResult[] | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [stats, setStats] = useState<CallStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const key = keys.find((k) => k.prefix === keyPrefix);
  const keyAllows = (scope: 'search' | 'answer') => key?.scopes.includes(scope) ?? false;

  const toggleLang = (l: Lang) => setLangs((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));

  function run(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!query.trim()) return setError(mode === 'search' ? 'Enter a query.' : 'Enter a question.');
    if (!key) return setError('Create an API key first.');
    if (!keyAllows(mode)) return setError(`This key doesn't have the “${mode}” scope. Pick another key or create one with it.`);

    if (live) {
      void runLive();
      return;
    }
    setRunning(true);
    const latencyMs = (mode === 'search' ? 360 : 1100) + Math.floor(Math.random() * 120);
    setTimeout(() => {
      // Demo of /v1/search: licence and territory filtering happen before ranking.
      const pool = corpus.filter((c) => langs.length === 0 || langs.includes(c.language)).sort((a, b) => b.score - a.score);
      const hits = pool.slice(0, mode === 'search' ? limit : 3);
      const tokens = mode === 'search' ? hits.reduce((n, c) => n + c.tokens, 0) : 2210;
      setResults(hits);
      setAnswer(mode === 'answer' ? ANSWERS[answerLang] : null);
      setStats({ tokens, cost: costOf(tokens, pricePer1k), publishers: new Set(hits.map((h) => h.publisher)).size, latencyMs });
      setRunning(false);
    }, latencyMs);
  }

  /** Live: the real API, as the selected key (metered like any other call). */
  async function runLive() {
    setRunning(true);
    const r = await playgroundCall(mode, keyPrefix, body as Record<string, unknown>);
    setRunning(false);
    if (!r.ok) return setError(r.message);
    type Attribution = { publisher: string; title: string; url: string | null; licence: string; text: string };
    const d = r.data as {
      results?: Array<{ chunkId: string; score: number; language: string; text: string; attribution: Attribution }>;
      answer?: string;
      citations?: Array<{ n: number; documentId: string; attribution: Attribution }>;
      usage: { tokensServed: number; amountMicros: number };
      latencyMs: number;
    };
    const stripTitle = (text: string, title: string) => (text.startsWith(`${title}\n`) ? text.slice(title.length + 1) : text);
    const hits: ChunkResult[] =
      mode === 'search'
        ? (d.results ?? []).map((x) => ({
            chunkId: x.chunkId,
            score: x.score,
            language: x.language as ChunkResult['language'],
            title: x.attribution.title,
            text: stripTitle(x.text, x.attribution.title),
            publisher: x.attribution.publisher,
            licence: x.attribution.licence,
            tokens: 0,
            url: x.attribution.url ?? '',
          }))
        : (d.citations ?? []).map((c) => ({
            chunkId: c.documentId,
            score: 0,
            language: 'en' as const,
            title: c.attribution.title,
            text: c.attribution.url ?? '',
            publisher: c.attribution.publisher,
            licence: c.attribution.licence,
            tokens: 0,
            url: c.attribution.url ?? '',
          }));
    setResults(hits);
    setAnswer(mode === 'answer' ? (d.answer ?? '') : null);
    setStats({ tokens: d.usage.tokensServed, cost: d.usage.amountMicros / 1e6, publishers: new Set(hits.map((h) => h.publisher)).size, latencyMs: d.latencyMs });
  }

  const body =
    mode === 'search'
      ? { query, languages: langs, limit, use: 'rag' }
      : { question: query, answerLanguage: answerLang, maxSources: 5 };
  const curl = [
    `curl ${API_BASE}/v1/${mode} \\`,
    `  -H "Authorization: Bearer fs_${keyPrefix}_…" \\`,
    `  -d '${JSON.stringify(body, null, 2).replaceAll('\n', '\n  ')}'`,
  ].join('\n');

  const langSummary = results && results.length > 0 ? [...new Set(results.map((r) => LANG_NAME[r.language]))].join(' and ') : null;

  return (
    <>
      <PageHeader
        title="Playground"
        description="Try the licensed API with your own key. Calls here are metered like any other."
        actions={
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-muted">API key</span>
            <select
              value={keyPrefix}
              onChange={(e) => setKeyPrefix(e.target.value)}
              className="rounded-xl border border-line bg-card px-4 py-3 font-mono text-[15px] outline-none focus:border-brand"
            >
              {keys.map((k) => (
                <option key={k.prefix} value={k.prefix}>
                  {k.name} · fs_{k.prefix}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1.9fr_1fr]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <form onSubmit={run}>
              <Segmented
                label="Endpoint"
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  setResults(null);
                  setAnswer(null);
                  setStats(null);
                  setQuery(m === 'search' ? 'पुणे मेट्रो का नया रूट क्या है?' : 'What is the new Pune metro route?');
                }}
                options={[
                  { value: 'search', label: 'Search' },
                  { value: 'answer', label: 'Answer' },
                ]}
              />
              <label htmlFor="q" className="mt-6 block text-[16px] font-medium">
                {mode === 'search' ? 'Query (any language)' : 'Question (any language)'}
              </label>
              <textarea
                id="q"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                rows={3}
                className="mt-2 w-full resize-y rounded-xl border border-line bg-card px-4 py-3.5 text-[18px] outline-none focus:border-brand"
              />
              <div className="mt-5 flex flex-wrap items-end justify-between gap-5">
                <div className="flex flex-wrap gap-6">
                  {mode === 'search' ? (
                    <>
                      <fieldset>
                        <legend className="mb-2 text-sm text-muted">Content languages</legend>
                        <div className="flex gap-2">
                          {(['mr', 'hi', 'en'] as const).map((l) => (
                            <button
                              key={l}
                              type="button"
                              aria-pressed={langs.includes(l)}
                              title={LANG_NAME[l]}
                              onClick={() => toggleLang(l)}
                              className={cx(
                                'rounded-xl border px-4 py-2.5 font-mono text-[15px] transition-colors',
                                langs.includes(l) ? 'border-brand/40 bg-brand-tint text-brand' : 'border-line bg-card text-muted hover:bg-subtle',
                              )}
                            >
                              {l}
                            </button>
                          ))}
                        </div>
                      </fieldset>
                      <label className="flex flex-col">
                        <span className="mb-2 text-sm text-muted">Results</span>
                        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="rounded-xl border border-line bg-card px-4 py-2.5 text-[15px]">
                          {[1, 3, 5, 10].map((n) => (
                            <option key={n}>{n}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  ) : (
                    <label className="flex flex-col">
                      <span className="mb-2 text-sm text-muted">Answer language</span>
                      <select value={answerLang} onChange={(e) => setAnswerLang(e.target.value as 'en' | 'hi')} className="rounded-xl border border-line bg-card px-4 py-2.5 text-[15px]">
                        <option value="en">English</option>
                        <option value="hi">Hindi</option>
                      </select>
                    </label>
                  )}
                </div>
                <Button type="submit" disabled={running} className="min-w-[180px]">
                  <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
                    <path d="M6 4l10 6-10 6z" fill="currentColor" />
                  </svg>
                  {running ? 'Running…' : mode === 'search' ? 'Run search' : 'Get answer'}
                </Button>
              </div>
              {error && (
                <p role="alert" className="mt-4 text-[15px] text-bad">
                  {error}
                </p>
              )}
            </form>
          </Card>

          {results && (
            <Card>
              {answer && (
                <div className="mb-7">
                  <CardTitle>Answer</CardTitle>
                  <p className="text-[17px] leading-relaxed">{answer}</p>
                </div>
              )}
              <CardTitle aside={langSummary && mode === 'search' ? `${langSummary} matches` : undefined}>
                {mode === 'answer' ? 'Citations' : `${results.length} licensed ${results.length === 1 ? 'result' : 'results'}`}
              </CardTitle>
              {results.length === 0 ? (
                <p className="text-muted">No licensed content matched. Try more content languages.</p>
              ) : (
                <ol className="flex flex-col gap-4">
                  {results.map((r, i) => (
                    <li key={r.chunkId} className="rounded-2xl border border-line p-5">
                      <div className="flex flex-wrap items-center gap-2.5 text-sm">
                        {mode === 'answer' ? (
                          <span className="rounded-md bg-brand-tint px-2 py-1 font-mono text-brand">[{i + 1}]</span>
                        ) : (
                          <span className="rounded-md bg-brand-tint px-2 py-1 font-mono text-brand tabular">{r.score.toFixed(2)}</span>
                        )}
                        <span className="rounded-md bg-neutral-tint px-2 py-1">{LANG_NAME[r.language]}</span>
                        <span className="font-mono text-muted">{r.chunkId}</span>
                      </div>
                      <h3 className="mt-3 text-[18px] font-semibold">{r.title}</h3>
                      <p className="mt-2 text-[17px] leading-relaxed">{r.text}</p>
                      <p className="mt-4 border-t border-line pt-3 text-sm text-muted">
                        Source: {r.publisher}, licensed via FairSource · <span className="font-mono">{r.licence}</span>
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardTitle>This call</CardTitle>
            <dl className="flex flex-col gap-3 text-[15px]">
              {[
                ['Tokens served', stats ? int(stats.tokens) : '—'],
                ['Cost', stats ? usd(stats.cost, 4) : '—'],
                ['Publishers credited', stats ? String(stats.publishers) : '—'],
                ['Latency', stats ? `${stats.latencyMs} ms` : '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-mono tabular">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-5 text-sm leading-relaxed text-muted">
              Results outside your licence (territory or use) were filtered out before ranking.
            </p>
          </Card>

          <Card dark>
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="font-display text-xl font-semibold">Request</h2>
              <CopyButton text={curl} />
            </div>
            <pre className="overflow-x-auto font-mono text-[14px] leading-relaxed whitespace-pre-wrap break-words text-white/90">{curl}</pre>
          </Card>
        </div>
      </div>
    </>
  );
}

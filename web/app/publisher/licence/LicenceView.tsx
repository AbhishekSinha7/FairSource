'use client';

import type { Territory, Use } from '@fairsource/shared';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { saveLicence } from '@/app/actions';
import { Button, Card, CardTitle, PageHeader, Pill, Toggle } from '@/components/ui';
import type { getLicence } from '@/lib/data';
import { costOf, dayMonth, usd } from '@/lib/format';
import { licenceTag, sameTerms, type LicenceTerms, type LicenceVersionView } from '@/lib/licence';

type Props = Awaited<ReturnType<typeof getLicence>>;

const TYPICAL_SEARCH_TOKENS = 1840;

const today = () => new Date().toISOString().slice(0, 10);
const fullDate = (iso: string) => `${dayMonth(iso)} ${iso.slice(0, 4)}`;

export function LicenceView({ versions: initial, share, monthTokens, publisherName, live = false }: Props & { live?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [versions, setVersions] = useState<LicenceVersionView[]>(initial);
  const active = versions[0]!;
  const [draft, setDraft] = useState<LicenceTerms>({ uses: active.uses, territories: active.territories, pricePer1k: active.pricePer1k });
  const [priceText, setPriceText] = useState(String(active.pricePer1k));
  const [saved, setSaved] = useState(false);

  const price = Number(priceText);
  const priceValid = priceText.trim() !== '' && Number.isFinite(price) && price > 0 && price <= 1;
  const current: LicenceTerms = { ...draft, pricePer1k: priceValid ? price : active.pricePer1k };
  const dirty = !sameTerms(current, active) || (priceText.trim() !== String(active.pricePer1k) && !priceValid);
  const servesNobody = draft.uses.length === 0 || draft.territories.length === 0;
  const canSave = dirty && priceValid;
  const shownVersion = dirty ? active.version + 1 : active.version;

  const flip = <T extends string>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const setUse = (u: Use, on: boolean) => {
    setSaved(false);
    setDraft((d) => ({ ...d, uses: flip(d.uses, u, on) }));
  };
  const setTerritory = (t: Territory, on: boolean) => {
    setSaved(false);
    setDraft((d) => ({ ...d, territories: flip(d.territories, t, on) }));
  };

  async function save() {
    if (!canSave || busy) return;
    let version = active.version + 1;
    if (live) {
      setBusy(true);
      setSaveError(null);
      const r = await saveLicence({ uses: current.uses, territories: current.territories, pricePer1k: current.pricePer1k });
      setBusy(false);
      if (!r.ok) return setSaveError(r.message);
      version = r.data.version;
      router.refresh();
    }
    const next: LicenceVersionView = { ...current, version, createdAt: today() };
    setVersions((v) => [next, ...v]);
    setPriceText(String(next.pricePer1k));
    setSaved(true);
  }

  function discard() {
    setDraft({ uses: active.uses, territories: active.territories, pricePer1k: active.pricePer1k });
    setPriceText(String(active.pricePer1k));
  }

  const p = priceValid ? price : active.pricePer1k;

  return (
    <>
      <PageHeader
        title="Licence"
        description="Decide how AI buyers may use your content and what they pay. Every save creates a new version."
        actions={
          <Pill tone="good" className="px-4 py-2 text-[15px]">
            Version {active.version} · active since {dayMonth(active.createdAt)}
          </Pill>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1.8fr_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardTitle>Allowed uses</CardTitle>
            <Row
              title="RAG and agent answers"
              body="Buyers retrieve your articles at query time to ground answers, with attribution."
              control={<Toggle label="RAG and agent answers" checked={draft.uses.includes('rag')} onChange={(on) => setUse('rag', on)} />}
            />
            <Row
              title="Model training"
              body="Buyers may include your articles in training datasets, delivered with a signed manifest."
              control={<Toggle label="Model training" checked={draft.uses.includes('training')} onChange={(on) => setUse('training', on)} />}
            />
          </Card>

          <Card>
            <CardTitle>Territories</CardTitle>
            <Row
              title="India"
              body="Buyers based in India."
              control={<Toggle label="India" checked={draft.territories.includes('IN')} onChange={(on) => setTerritory('IN', on)} />}
            />
            <Row
              title="Global"
              body="Buyers in any other country."
              control={<Toggle label="Global" checked={draft.territories.includes('GLOBAL')} onChange={(on) => setTerritory('GLOBAL', on)} />}
            />
          </Card>

          <Card>
            <CardTitle>Price</CardTitle>
            <label htmlFor="price" className="text-[16px] font-medium">
              Price per 1,000 tokens (USD)
            </label>
            <div className="mt-3 flex w-full max-w-sm items-center rounded-xl border border-line bg-card px-4 focus-within:border-brand">
              <span className="font-mono text-muted">$</span>
              <input
                id="price"
                value={priceText}
                onChange={(e) => {
                  setSaved(false);
                  setPriceText(e.target.value);
                }}
                inputMode="decimal"
                className="w-full bg-transparent px-3 py-3.5 font-mono text-[17px] outline-none"
                aria-invalid={!priceValid}
                aria-describedby="price-help"
              />
            </div>
            <p id="price-help" className={priceValid ? 'sr-only' : 'mt-2 text-sm text-bad'}>
              {priceValid ? 'Price in US dollars per 1,000 tokens.' : 'Enter a price above $0 and up to $1 per 1,000 tokens.'}
            </p>
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <Calc label={`Typical search (${TYPICAL_SEARCH_TOKENS.toLocaleString('en-US')} tokens)`} value={usd(costOf(TYPICAL_SEARCH_TOKENS, p), 4)} />
              <Calc label={`You receive (${Math.round(share * 100)}%)`} value={usd(costOf(TYPICAL_SEARCH_TOKENS, p) * share, 4)} good />
              <Calc label="At this month's volume" value={usd(costOf(monthTokens, p) * share)} />
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card dark>
            <h2 className="font-display text-xl font-semibold">What buyers see</h2>
            <div className="mt-6 text-sm text-white/65">Licence tag on every result</div>
            <div className="mt-1.5 font-mono text-xl">{licenceTag(draft, shownVersion)}</div>
            <div className="mt-6 text-sm text-white/65">Attribution text</div>
            <div className="mt-1.5 text-[16px] leading-relaxed">Source: {publisherName}, licensed via FairSource</div>
            {servesNobody && (
              <p role="alert" className="mt-5 rounded-xl bg-warn-tint px-4 py-3 text-sm text-warn">
                With no {draft.uses.length === 0 ? 'allowed use' : 'territory'} switched on, your content won&apos;t be served to any buyer.
              </p>
            )}
            <p className="mt-5 text-sm leading-relaxed text-white/65">
              Changes reach every article within seconds. Past uses keep the terms that were in force when they happened.
            </p>
            {canSave ? (
              <div className="mt-6 flex flex-col gap-3">
                <Button onClick={save} className="w-full" disabled={busy}>
                  {busy ? 'Saving…' : `Save as version ${active.version + 1}`}
                </Button>
                {saveError && (
                  <p role="alert" className="text-sm text-[#ffb4a8]">
                    {saveError}
                  </p>
                )}
                <Button variant="dark" onClick={discard} className="w-full">
                  Discard changes
                </Button>
              </div>
            ) : (
              <div className="mt-6 rounded-xl bg-panel-raised px-4 py-3.5 text-center text-[16px] font-semibold text-white/55" role="status">
                {saved ? `Saved · version ${active.version} is live` : dirty ? 'Fix the price to save' : 'No unsaved changes'}
              </div>
            )}
          </Card>

          <Card>
            <CardTitle>Version history</CardTitle>
            <ol className="divide-y divide-line">
              {versions.map((v, i) => (
                <li key={v.version} className="flex items-start justify-between gap-4 py-4 first:pt-0">
                  <div>
                    <div className="text-[16px] font-semibold">
                      v{v.version}
                      {i === 0 && ' · active'}
                    </div>
                    <div className="text-[15px] text-muted">{fullDate(v.createdAt)}</div>
                  </div>
                  <div className="text-right font-mono text-sm text-muted">
                    {v.uses.join('+') || 'none'} · {v.territories.join('+') || 'none'} · ${v.pricePer1k}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ title, body, control }: { title: string; body: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-t border-line py-5 last:pb-0">
      <div>
        <div className="text-[16px] font-semibold">{title}</div>
        <div className="mt-1 text-[15px] text-muted">{body}</div>
      </div>
      {control}
    </div>
  );
}

function Calc({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="rounded-xl bg-subtle px-5 py-4">
      <div className="text-sm text-muted">{label}</div>
      <div className={`mt-2 font-mono text-[19px] tabular ${good ? 'text-good' : ''}`}>{value}</div>
    </div>
  );
}

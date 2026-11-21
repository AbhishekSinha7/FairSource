'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { connectSource, requestUpload, syncSource } from '@/app/actions';
import { Button, Card, CardTitle, CheckIcon, PageHeader, Pill, Td, Th, cx } from '@/components/ui';
import type { getSources } from '@/lib/data';
import { int } from '@/lib/format';
import type { SourceView } from '@/lib/mock';

type Props = Awaited<ReturnType<typeof getSources>>;
type Tab = 'rss' | 'sitemap' | 'upload';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'mpeg', 'mpg'];
/** What ingest accepts (services/ingest/src/uploads.ts). Checked here so a wrong file fails at once, not after a round trip. */
const UPLOAD_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'zip', ...VIDEO_EXTENSIONS];
const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const isVideoFile = (f: File) => VIDEO_EXTENSIONS.includes(extensionOf(f.name));
const limitFor = (f: File) => (isVideoFile(f) ? MAX_VIDEO_BYTES : MAX_FILE_BYTES);

/** PUT to the signed Cloud Storage URL, reporting progress (fetch can't report upload progress). */
function putWithProgress(url: string, file: File, onProgress: (sent: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve(xhr.status);
    // A network error here is almost always the bucket's CORS rule missing this site (infra/deploy.sh sets it).
    xhr.onerror = () => reject(new Error('the browser could not reach Cloud Storage'));
    xhr.ontimeout = () => reject(new Error('the upload timed out'));
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(file);
  });
}

export function SourcesView({ sources: initialSources, steps, latestItem, live = false }: Props & { live?: boolean }) {
  const router = useRouter();
  const [sources, setSources] = useState<SourceView[]>(initialSources);
  const [item, setItem] = useState(latestItem);
  useEffect(() => setSources(initialSources), [initialSources]); // live mode: fresh data after router.refresh()
  useEffect(() => setItem(latestItem), [latestItem]);
  useEffect(() => {
    if (!live || !sources.some((s) => s.status === 'backfilling')) return;
    const id = setInterval(() => router.refresh(), 5000); // follow the backfill
    return () => clearInterval(id);
  }, [live, sources, router]);
  const [replayKey, setReplayKey] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));

  const update = (id: string, patch: Partial<SourceView>) =>
    setSources((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  /** Demo of what ingest does: "Sync now" runs the source at once. */
  async function syncNow(s: SourceView) {
    update(s.id, { status: 'syncing', lastSyncNote: undefined });
    if (live) {
      const r = await syncSource(s.id);
      update(s.id, r.ok ? { status: 'healthy', lastRun: 'Just now', lastSyncNote: r.data.note } : { status: 'error', lastSyncNote: r.message });
      router.refresh();
      return;
    }
    later(() => {
      const fresh = Math.floor(Math.random() * 3);
      const edited = Math.floor(Math.random() * 2);
      const note = fresh + edited === 0 ? 'No changes' : [fresh && `${fresh} new`, edited && `${edited} updated`].filter(Boolean).join(' · ');
      update(s.id, { status: 'healthy', lastRun: 'Just now', items: (s.items ?? 0) + fresh, lastSyncNote: note });
    }, 1800);
  }

  /** Demo of backfill: a newly connected feed imports its existing posts first. */
  function connect(type: 'RSS' | 'Sitemap', name: string, url: string) {
    const id = `src_${Date.now()}`;
    const total = 180 + Math.floor(Math.random() * 240);
    setSources((all) => {
      const cms = all.filter((s) => s.type === 'CMS');
      const rest = all.filter((s) => s.type !== 'CMS');
      return [
        ...rest,
        { id, name, detail: url, type, schedule: 'Every 30 min', lastRun: 'Just now', items: 0, status: 'backfilling', backfill: { done: 0, total } },
        ...cms,
      ];
    });
    let done = 0;
    const tick = () => {
      done = Math.min(total, done + Math.ceil(total / 9));
      if (done >= total) {
        update(id, { status: 'healthy', items: total, backfill: undefined, lastSyncNote: `Imported ${int(total)} posts` });
      } else {
        update(id, { items: done, backfill: { done, total } });
        later(tick, 700);
      }
    };
    later(tick, 700);
  }

  /** Live: each file goes straight to Cloud Storage with a signed URL; processing starts on arrival. */
  async function uploadLive(files: File[], onProgress: (pct: number) => void): Promise<{ ok: boolean; message: string }> {
    const total = files.reduce((n, f) => n + f.size, 0) || 1;
    let before = 0;
    let done = 0;
    const partly = (why: string) => ({ ok: false, message: done ? `${done} of ${files.length} files uploaded. ${why}` : why });
    for (const f of files) {
      const r = await requestUpload({ name: f.name, type: f.type || 'application/octet-stream', size: f.size });
      if (!r.ok) return partly(`${f.name}: ${r.message}`);
      let status: number;
      try {
        status = await putWithProgress(r.data.uploadUrl, f, (sent) => onProgress(Math.round(((before + sent) / total) * 100)));
      } catch (e) {
        return partly(`${f.name}: upload failed, ${(e as Error).message}. Try again; if it keeps failing, the storage bucket's CORS setting needs this site's address.`);
      }
      if (status < 200 || status >= 300) return partly(`${f.name}: upload failed (${status}).`);
      before += f.size;
      done += 1;
    }
    setTimeout(() => router.refresh(), 4000);
    return { ok: true, message: `${done} ${done === 1 ? 'file' : 'files'} uploaded. Processing has started; results appear here in under a minute.` };
  }

  function uploaded(files: File[]) {
    const first = files[0]!;
    setItem({ name: first.name, detail: `${isVideoFile(first) ? 'video, transcribed' : `${Math.max(1, Math.round(first.size / 180_000))} pages`} · uploaded ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` });
    setReplayKey((k) => k + 1);
    setSources((all) =>
      all.map((s) => (s.type === 'Upload' ? { ...s, items: (s.items ?? 0) + files.length, itemsLabel: `${(s.items ?? 0) + files.length} pages`, lastRun: 'Just now' } : s)),
    );
  }

  const total = sources.reduce((n, s) => n + (s.type === 'CMS' ? 0 : (s.items ?? 0)), 0);

  return (
    <>
      <PageHeader
        title="Sources"
        description="Connect a feed or upload files once. We import your existing posts, then check for new and edited ones every 30 minutes."
      />

      <div className="grid gap-6 xl:grid-cols-[1.45fr_1fr]">
        <AddSource
          onConnect={connect}
          onUpload={uploaded}
          live={
            live
              ? {
                  connect: async (type, url, consent) => {
                    const r = await connectSource(type, url, consent);
                    if (r.ok) router.refresh();
                    return r.ok ? { ok: true, message: r.data.message } : { ok: false, message: r.message };
                  },
                  upload: uploadLive,
                }
              : undefined
          }
        />
        <ProcessingPanel key={replayKey} steps={steps} item={item} onReplay={() => setReplayKey((k) => k + 1)} />
      </div>

      <Card className="mt-6">
        <CardTitle aside={`${int(total)} items in total`}>Connected sources</CardTitle>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead className="border-b border-line">
              <tr>
                <Th>Source</Th>
                <Th>Type</Th>
                <Th>Schedule</Th>
                <Th>Last run</Th>
                <Th className="text-right">Items</Th>
                <Th className="pl-6">Status</Th>
                <Th className="sr-only">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sources.map((s) => {
                const soon = s.status === 'soon';
                const canSync = (s.type === 'RSS' || s.type === 'Sitemap') && s.status !== 'backfilling';
                return (
                  <tr key={s.id} className={cx(soon && 'text-muted')}>
                    <Td className="pr-4">
                      <div className={cx('text-[16px]', !soon && 'text-ink')}>{s.name}</div>
                      <div className={cx('text-sm text-muted', (s.type === 'RSS' || s.type === 'Sitemap') && 'font-mono')}>{s.detail}</div>
                    </Td>
                    <Td>{s.type}</Td>
                    <Td className={cx(s.type === 'Upload' && 'text-muted')}>{s.schedule}</Td>
                    <Td>
                      <div>{s.lastRun}</div>
                      {s.lastSyncNote && <div className="text-sm text-muted">{s.lastSyncNote}</div>}
                    </Td>
                    <Td className="text-right tabular">{s.items === null ? '—' : (s.itemsLabel ?? int(s.items))}</Td>
                    <Td className="pl-6">
                      <SourceStatus s={s} />
                    </Td>
                    <Td className="pl-4 text-right">
                      {canSync && (
                        <Button variant="secondary" size="sm" disabled={s.status === 'syncing'} onClick={() => syncNow(s)}>
                          {s.status === 'syncing' ? 'Syncing…' : 'Sync now'}
                        </Button>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function SourceStatus({ s }: { s: SourceView }) {
  switch (s.status) {
    case 'healthy':
      return <Pill tone="good">Healthy</Pill>;
    case 'review':
      return <Pill tone="warn">{s.reviewCount} need review</Pill>;
    case 'syncing':
      return <Pill tone="brand">Syncing</Pill>;
    case 'backfilling':
      return (
        <div className="min-w-[150px]">
          <Pill tone="brand">
            Backfilling · {int(s.backfill?.done ?? 0)} of {int(s.backfill?.total ?? 0)}
          </Pill>
          <div className="mt-2 h-1.5 rounded-full bg-neutral-tint">
            <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${((s.backfill?.done ?? 0) / (s.backfill?.total || 1)) * 100}%` }} />
          </div>
        </div>
      );
    case 'error':
      return <Pill tone="bad">Error</Pill>;
    case 'soon':
      return <Pill tone="neutral">Coming soon</Pill>;
  }
}

interface LiveSourceActions {
  connect: (type: 'rss' | 'sitemap', url: string, consent: boolean) => Promise<{ ok: boolean; message: string }>;
  upload: (files: File[], onProgress: (pct: number) => void) => Promise<{ ok: boolean; message: string }>;
}

function AddSource({
  onConnect,
  onUpload,
  live,
}: {
  onConnect: (type: 'RSS' | 'Sitemap', name: string, url: string) => void;
  onUpload: (files: File[]) => void;
  live?: LiveSourceActions;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('rss');
  const [url, setUrl] = useState('');
  const [consent, setConsent] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'rss', label: 'RSS / Atom feed' },
    { id: 'sitemap', label: 'Sitemap' },
    { id: 'upload', label: 'Upload files' },
  ];

  function pick(list: FileList | null) {
    if (!list) return;
    const all = [...list];
    const unsupported = all.filter((f) => !UPLOAD_EXTENSIONS.includes(extensionOf(f.name)));
    const tooBig = all.filter((f) => !unsupported.includes(f) && f.size > limitFor(f));
    setFiles(all.filter((f) => !unsupported.includes(f) && !tooBig.includes(f)));
    const names = (fs: File[]) => fs.map((f) => f.name).join(', ');
    const audio = unsupported.some((f) => f.type.startsWith('audio/'));
    const otherVideo = unsupported.some((f) => f.type.startsWith('video/'));
    const problems = [
      unsupported.length
        ? `${names(unsupported)} can't be uploaded: ${audio ? 'audio isn\u2019t supported yet. ' : otherVideo ? 'convert the video to MP4 first. ' : ''}FairSource reads PDFs, images (JPEG, PNG, WebP, TIFF), videos (MP4, MOV, WebM, MPEG) and ZIPs.`
        : '',
      tooBig.length ? `${names(tooBig)} ${tooBig.length === 1 ? 'is' : 'are'} too big (up to 10 MB per document, 100 MB per video) and won't be uploaded.` : '',
    ].filter(Boolean);
    setError(problems.length ? problems.join(' ') : null);
    setNotice(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!consent) return setError('Please confirm you own or control this content.');

    if (live) {
      if (tab === 'upload' && !files.length) return setError('Choose at least one file.');
      if (tab !== 'upload' && !url.trim()) return setError('Enter a web address, like example.in/feed or example.in.');
      setBusy(true);
      setError(null);
      try {
        const r = tab === 'upload' ? await live.upload(files, setProgress) : await live.connect(tab, url, consent);
        if (r.ok) {
          setNotice(r.message);
          if (tab === 'upload') setFiles([]);
          else setUrl('');
        } else setError(r.message);
      } catch {
        // A server action that failed outright (network, deploy in progress): never leave the button stuck.
        setError('Something went wrong. Check your connection and try again.');
      } finally {
        setBusy(false);
        setProgress(null);
      }
      return;
    }

    if (tab === 'upload') {
      if (!files.length) return setError('Choose at least one file.');
      onUpload(files);
      setNotice(`${files.length} ${files.length === 1 ? 'file' : 'files'} uploaded. Processing has started.`);
      setFiles([]);
      setError(null);
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
      if (!parsed.hostname.includes('.')) throw new Error();
    } catch {
      return setError('Enter a web address, like example.in/feed or example.in.');
    }
    setError(null);

    const host = parsed.hostname.replace(/^www\./, '');
    const isFeedPath = /(rss|feed|atom|\.xml)/i.test(parsed.pathname);
    let display = `${host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    let found = '';
    if (tab === 'rss' && !isFeedPath) {
      display = `${host}/feed`;
      found = ` We found your feed at ${display}.`;
    } else if (tab === 'sitemap' && !isFeedPath) {
      display = `${host}/sitemap.xml`;
      found = ` We found your sitemap at ${display} (from robots.txt).`;
    }
    onConnect(tab === 'rss' ? 'RSS' : 'Sitemap', host, display);
    setNotice(`Connected.${found} Importing your existing posts now.`);
    setUrl('');
  }

  return (
    <Card>
      <CardTitle>Add a source</CardTitle>
      <div className="flex flex-wrap gap-3" role="tablist" aria-label="Source type">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setError(null);
              setNotice(null);
            }}
            className={cx(
              'rounded-xl border px-5 py-3 text-[16px] transition-colors',
              tab === t.id ? 'border-brand/50 bg-brand-tint text-brand' : 'border-line bg-card hover:bg-subtle',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="mt-6">
        {tab === 'upload' ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files);
            }}
            className={cx(
              'flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors',
              dragging ? 'border-brand bg-brand-tint/50' : 'border-[#d9d6cc] bg-[#faf9f6]',
            )}
          >
            <svg viewBox="0 0 24 24" className="size-9 text-brand" aria-hidden="true">
              <path d="M12 16V4m0 0l-5 5m5-5l5 5M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="mt-4 text-[17px] font-semibold">Drop PDFs, images, videos or a ZIP here</div>
            <p className="mt-2 text-[15px] text-muted">
              Scans are read with Gemini OCR; videos are transcribed, with on-screen text. Up to 10 MB per document and 100 MB per video; ZIPs are expanded.
            </p>
            <input
              ref={input}
              type="file"
              multiple
              accept={UPLOAD_EXTENSIONS.map((x) => `.${x}`).join(',')}
              className="sr-only"
              onChange={(e) => {
                pick(e.target.files);
                e.target.value = ''; // so choosing the same file again still fires
              }}
            />
            <Button variant="secondary" className="mt-5" onClick={() => input.current?.click()}>
              Choose files
            </Button>
            {files.length > 0 && (
              <ul className="mt-5 w-full max-w-md text-left text-sm">
                {files.map((f) => (
                  <li key={f.name} className="flex justify-between gap-3 border-t border-line py-2">
                    <span className="truncate">{f.name}</span>
                    <span className="shrink-0 text-muted tabular">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div>
            <label htmlFor="source-url" className="text-[15px] font-medium">
              {tab === 'rss' ? 'Feed or site address' : 'Sitemap or site address'}
            </label>
            <input
              id="source-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={tab === 'rss' ? 'example.in/rss/pune' : 'example.in/news-sitemap.xml'}
              className="mt-2 w-full rounded-xl border border-line bg-card px-4 py-3 font-mono text-[15px] outline-none focus:border-brand"
              autoComplete="url"
              inputMode="url"
            />
            <p className="mt-2 text-sm text-muted">
              Paste just your site address and we&apos;ll find the {tab === 'rss' ? 'feed' : 'sitemap'}. We import your existing posts first, then pick up new
              and edited posts every 30 minutes, and remove posts you delete.
            </p>
          </div>
        )}

        <label className="mt-6 flex cursor-pointer gap-3.5 rounded-xl bg-subtle px-5 py-4 text-[15px] leading-relaxed">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 size-5 shrink-0 accent-brand" />
          <span>
            I own or control this content and consent to it being licensed to AI buyers under my licence terms. We respect robots.txt and fetch at most one
            request per second.
          </span>
        </label>

        {error && (
          <p role="alert" className="mt-4 text-[15px] text-bad">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-4 text-[15px] text-good">
            {notice}
          </p>
        )}

        <Button type="submit" className="mt-6" disabled={!consent || busy}>
          {busy ? (tab === 'upload' ? `Uploading…${progress !== null ? ` ${progress}%` : ''}` : 'Connecting…') : tab === 'upload' ? 'Upload and process' : 'Connect and import'}
        </Button>
      </form>
    </Card>
  );
}

function ProcessingPanel({ steps, item, onReplay }: { steps: Props['steps']; item: Props['latestItem']; onReplay: () => void }) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return setShown(steps.length);
    const id = setInterval(() => setShown((n) => (n >= steps.length ? n : n + 1)), 420);
    return () => clearInterval(id);
  }, [steps.length]);

  return (
    <Card dark>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold">Processing · latest item</h2>
          <p className="mt-1 truncate text-sm text-white/65">
            {item.name} · {item.detail}
          </p>
        </div>
        <Button variant="dark" size="sm" onClick={onReplay}>
          Replay
        </Button>
      </div>
      <ol className="mt-6 flex flex-col gap-5" aria-live="polite">
        {steps.map((s, i) => {
          const state = i < shown ? (s.ok ? 'done' : 'flagged') : i === shown ? 'running' : 'waiting';
          return (
            <li key={s.title} className={cx('flex gap-4 transition-opacity', state === 'waiting' && 'opacity-35')}>
              <span
                className={cx(
                  'grid size-7 shrink-0 place-items-center rounded-full',
                  state === 'done' ? 'bg-good-bright text-panel' : state === 'flagged' ? 'bg-[#f5b942] text-panel' : 'border-2 border-white/25',
                  state === 'running' && 'animate-pulse border-good-bright',
                )}
              >
                {state === 'done' && <CheckIcon className="size-4" />}
                {state === 'flagged' && <span className="text-sm font-bold" aria-label="needs attention">!</span>}
              </span>
              <div>
                <div className="text-[16px] font-semibold">{s.title}</div>
                <div className="text-sm text-white/65">{s.detail}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createKey, revokeKey } from '@/app/actions';
import { CopyButton } from '@/components/CopyButton';
import { ExternalIcon } from '@/components/Shell';
import { Button, Card, CardTitle, PageHeader, Pill, Segmented, Td, Th, cx } from '@/components/ui';
import { MCP_URL } from '@/lib/config';
import type { getKeys } from '@/lib/data';
import type { KeyView } from '@/lib/mock';

type Props = Awaited<ReturnType<typeof getKeys>>;
type Scope = KeyView['scopes'][number];
type Client = 'claude' | 'gemini';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const randomId = (n: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
};

function mcpConfig(client: Client, prefix: string): string {
  const auth = { Authorization: `Bearer fs_${prefix}_…` };
  const server = client === 'claude' ? { type: 'http', url: MCP_URL, headers: auth } : { httpUrl: MCP_URL, headers: auth };
  return JSON.stringify({ mcpServers: { fairsource: server } }, null, 2);
}

export function KeysView({ keys: initial, live = false }: Props & { live?: boolean }) {
  const [keys, setKeys] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [client, setClient] = useState<Client>('claude');

  const configKey = keys.find((k) => !k.revoked)?.prefix ?? 'xxxxxxxx';
  const config = mcpConfig(client, configKey);

  async function revoke(prefix: string) {
    if (live) {
      const r = await revokeKey(prefix);
      if (!r.ok) return;
    }
    setKeys((all) => all.map((k) => (k.prefix === prefix ? { ...k, revoked: true } : k)));
    setConfirmRevoke(null);
  }

  /** Returns an error message, or null when the key was created. */
  async function created(name: string, scopes: Scope[]): Promise<string | null> {
    let prefix: string;
    let key: string;
    if (live) {
      // Created on the server; only its SHA-256 hash is stored.
      const r = await createKey(name, scopes);
      if (!r.ok) return r.message;
      ({ prefix, key } = r.data);
    } else {
      prefix = randomId(8);
      key = `fs_${prefix}_${randomId(32)}`;
    }
    setKeys((all) => [{ prefix, name, scopes, created: 'Today', lastUsed: 'Never', revoked: false }, ...all]);
    setNewKey(key);
    return null;
  }

  return (
    <>
      <PageHeader
        title="API keys & MCP"
        description="One key works for the REST API and the MCP server. We store only a hash, so a key is shown once."
        actions={
          <>
          <a
            href="/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-card px-5 py-3 text-[15px] font-semibold transition-colors hover:bg-subtle"
          >
            API docs
            <ExternalIcon />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <Button onClick={() => setCreating(true)}>
            <span aria-hidden="true" className="text-xl leading-none">
              +
            </span>
            Create key
          </Button>
          </>
        }
      />

      {newKey && (
        <Card className="mb-6 border-good/30 bg-good-tint">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="font-semibold text-good">Your new key. Copy it now; you won&apos;t see it again.</div>
              <code className="mt-2 block font-mono text-[15px] break-all">{newKey}</code>
            </div>
            <div className="flex shrink-0 gap-3">
              <CopyButton text={newKey} variant="secondary" label="Copy key" />
              <Button variant="secondary" size="sm" onClick={() => setNewKey(null)}>
                Done
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <CardTitle>Keys</CardTitle>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="border-b border-line">
              <tr>
                <Th>Name</Th>
                <Th>Key</Th>
                <Th>Scopes</Th>
                <Th>Created</Th>
                <Th>Last used</Th>
                <Th className="sr-only">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {keys.map((k) => (
                <tr key={k.prefix} className={cx(k.revoked && 'text-muted')}>
                  <Td className="pr-4 text-[16px]">{k.name}</Td>
                  <Td className="pr-4 font-mono text-[15px]">fs_{k.prefix}_••••</Td>
                  <Td className="pr-4">{k.scopes.join(', ')}</Td>
                  <Td>{k.created}</Td>
                  <Td>{k.lastUsed}</Td>
                  <Td className="text-right">
                    {k.revoked ? (
                      <Pill tone="neutral">Revoked</Pill>
                    ) : confirmRevoke === k.prefix ? (
                      <span className="inline-flex gap-2">
                        <Button variant="danger" size="sm" onClick={() => revoke(k.prefix)}>
                          Revoke now
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setConfirmRevoke(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button variant="danger" size="sm" onClick={() => setConfirmRevoke(k.prefix)}>
                        Revoke
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-5 text-sm text-muted">A revoked key stops working within 60 seconds.</p>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card dark className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-display text-xl font-semibold">Connect an AI agent over MCP</h2>
            <Segmented
              dark
              label="MCP client"
              value={client}
              onChange={setClient}
              options={[
                { value: 'claude', label: 'Claude' },
                { value: 'gemini', label: 'Gemini CLI' },
              ]}
            />
          </div>
          <dl className="mt-6 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-white/60">Endpoint</dt>
              <dd className="mt-1 font-mono text-[15px] break-all">{MCP_URL}</dd>
            </div>
            <div>
              <dt className="text-sm text-white/60">Transport</dt>
              <dd className="mt-1 text-[15px]">Streamable HTTP</dd>
            </div>
          </dl>
          <div className="mt-6 flex items-center justify-between gap-4">
            <span className="text-sm text-white/60">
              {client === 'claude' ? 'MCP client config (JSON)' : 'Add to ~/.gemini/settings.json'}
            </span>
            <CopyButton text={config} />
          </div>
          <pre className="mt-3 overflow-x-auto rounded-xl bg-panel-inset p-5 font-mono text-[14px] leading-relaxed text-white/90">{config}</pre>
          <p className="mt-5 text-[15px] leading-relaxed text-white/75">
            Replace the key with one of yours. Every tool call is checked against your licence and metered as{' '}
            <code className="font-mono text-white">endpoint = mcp</code>.
          </p>
        </Card>

        <Card>
          <CardTitle>Tools your agent gets</CardTitle>
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl border border-line p-5">
              <div className="font-mono text-[15px] font-semibold">search_licensed_content</div>
              <p className="mt-2 text-[15px] leading-relaxed">
                Search licensed, attributed articles in Indian and other languages. Results carry an attribution line to show with the answer.
              </p>
              <p className="mt-3 text-sm text-muted">query · languages · limit (1–10)</p>
            </div>
            <div className="rounded-2xl border border-dashed border-line p-5 text-muted">
              <div className="font-mono text-[15px] font-semibold">get_licensed_document</div>
              <p className="mt-2 text-[15px] leading-relaxed">Fetch a full licensed article by ID. Coming after the MVP.</p>
            </div>
          </div>
        </Card>
      </div>

      {creating && <CreateKeyDialog onClose={() => setCreating(false)} onCreate={created} />}
    </>
  );
}

function CreateKeyDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, scopes: Scope[]) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['search', 'answer']);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Give the key a name, like “Production agent”.');
    if (!scopes.length) return setError('Pick at least one scope.');
    setBusy(true);
    const err = await onCreate(name.trim(), scopes);
    setBusy(false);
    if (err) return setError(err);
    onClose();
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(480px,calc(100vw-32px))] rounded-2xl border border-line bg-card p-0 text-ink backdrop:bg-black/40"
    >
      <form onSubmit={submit} className="p-7">
        <h2 className="font-display text-xl font-semibold">Create key</h2>
        <label htmlFor="key-name" className="mt-5 block text-[15px] font-medium">
          Name
        </label>
        <input
          id="key-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Production agent"
          className="mt-2 w-full rounded-xl border border-line px-4 py-3 text-[16px] outline-none focus:border-brand"
        />
        <fieldset className="mt-5">
          <legend className="text-[15px] font-medium">Scopes</legend>
          <div className="mt-2 flex flex-col gap-2">
            {(['search', 'answer', 'documents'] as const).map((s) => (
              <label key={s} className="flex items-center gap-3 text-[15px]">
                <input
                  type="checkbox"
                  className="size-4.5 accent-brand"
                  checked={scopes.includes(s)}
                  onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                />
                <span className="font-mono">{s}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="mt-4 text-[15px] text-bad">
            {error}
          </p>
        )}
        <div className="mt-7 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create key'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

'use client';

import { useState } from 'react';
import { Button } from './ui';

export function CopyButton({ text, label = 'Copy', variant = 'dark' }: { text: string; label?: string; variant?: 'dark' | 'secondary' }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1600);
  }

  return (
    <Button variant={variant} size="sm" onClick={copy} aria-live="polite">
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Press Ctrl+C' : label}
    </Button>
  );
}

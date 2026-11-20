export const usd = (n: number, digits = 2) => `$${n.toFixed(digits)}`;

export const int = (n: number) => n.toLocaleString('en-US');

/** 4,620,000 -> "4.62M", 490,000 -> "490K". */
export function compact(n: number): string {
  if (n >= 1_000_000) return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/** Price per 1,000 tokens -> cost of `tokens`. */
export const costOf = (tokens: number, pricePer1k: number) => (tokens / 1000) * pricePer1k;

export const clock = (d: Date) =>
  d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-17" -> "17 Nov" */
export function dayMonth(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

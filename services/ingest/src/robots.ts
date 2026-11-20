// robots.txt (RFC 9309): pick the most specific group for our agent, longest
// matching rule wins, Allow wins a tie. A missing robots.txt (4xx) allows all;
// an unreachable one (5xx or network error) disallows all until the next try.

import { FetchError, type Fetcher } from './http.js';

export interface Robots {
  allowed(url: string): boolean;
  sitemaps: string[];
}

interface Rule {
  allow: boolean;
  pattern: string;
  re: RegExp;
}

const ALLOW_ALL: Robots = { allowed: () => true, sitemaps: [] };
const DENY_ALL: Robots = { allowed: () => false, sitemaps: [] };

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function parseRobots(txt: string, agent = 'fairsourcebot'): Robots {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;

  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();

    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && value === '') continue; // "Disallow:" with no path allows everything
      current.rules.push({ allow: key === 'allow', pattern: value, re: toRegex(value) });
    }
  }

  const me = agent.toLowerCase();
  // The group naming our agent most specifically wins; otherwise the "*" group.
  const score = (g: { agents: string[] }) => Math.max(0, ...g.agents.filter((a) => a !== '*' && me.includes(a)).map((a) => a.length));
  const best = Math.max(0, ...groups.map(score));
  const chosen = best > 0 ? groups.filter((g) => score(g) === best) : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);

  return {
    sitemaps,
    allowed(url: string) {
      const u = new URL(url);
      const path = decodeURIComponentSafe(u.pathname) + u.search;
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export class RobotsCache {
  private cache = new Map<string, { at: number; robots: Robots }>();

  constructor(
    private fetcher: Fetcher,
    private agent = 'fairsourcebot',
    private ttlMs = 60 * 60 * 1000,
  ) {}

  async get(url: string): Promise<Robots> {
    const origin = new URL(url).origin;
    const hit = this.cache.get(origin);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.robots;

    let robots: Robots;
    try {
      const res = await this.fetcher.get(`${origin}/robots.txt`, { accept: 'text/plain' });
      if (res.status >= 200 && res.status < 300) robots = parseRobots(res.text(), this.agent);
      else if (res.status >= 400 && res.status < 500) robots = ALLOW_ALL;
      else robots = DENY_ALL;
    } catch (e) {
      if (!(e instanceof FetchError)) throw e;
      robots = DENY_ALL;
    }
    this.cache.set(origin, { at: Date.now(), robots });
    return robots;
  }

  async allowed(url: string): Promise<boolean> {
    return (await this.get(url)).allowed(url);
  }
}

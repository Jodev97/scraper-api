import dns from 'node:dns';
import net from 'node:net';

export class SsrfError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

// ------------------------------------------------------------------ IP logic

/** Parses an IPv4/IPv6 literal into raw bytes (4 or 16). */
export function parseIp(input: string): Uint8Array | null {
  let ip = input.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);

  if (net.isIPv4(ip)) {
    return Uint8Array.from(ip.split('.').map((p) => Number(p)));
  }
  if (!net.isIPv6(ip)) return null;

  // Handle an embedded dotted IPv4 tail (::ffff:1.2.3.4).
  let head = ip;
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    if (!net.isIPv4(maybeV4)) return null;
    const b = maybeV4.split('.').map(Number) as [number, number, number, number];
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    head = ip.slice(0, lastColon + 1) + '0:0';
  }

  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parseGroups(halves[0] ?? '');
  const right = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (!left || !right) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

type V4 = readonly [number, number, number, number];

function blockedV4Reason(b: V4): string | null {
  const [a, b1, c] = b;
  if (a === 0) return 'this-network (0.0.0.0/8)';
  if (a === 10) return 'private (10.0.0.0/8)';
  if (a === 100 && b1 >= 64 && b1 <= 127) return 'CGNAT (100.64.0.0/10)';
  if (a === 127) return 'loopback (127.0.0.0/8)';
  if (a === 169 && b1 === 254) return 'link-local / metadata (169.254.0.0/16)';
  if (a === 172 && b1 >= 16 && b1 <= 31) return 'private (172.16.0.0/12)';
  if (a === 192 && b1 === 0 && c === 0) return 'IETF protocol assignments (192.0.0.0/24)';
  if (a === 192 && b1 === 0 && c === 2) return 'documentation (192.0.2.0/24)';
  if (a === 192 && b1 === 168) return 'private (192.168.0.0/16)';
  if (a === 198 && (b1 === 18 || b1 === 19)) return 'benchmarking (198.18.0.0/15)';
  if (a === 198 && b1 === 51 && c === 100) return 'documentation (198.51.100.0/24)';
  if (a === 203 && b1 === 0 && c === 113) return 'documentation (203.0.113.0/24)';
  if (a >= 224 && a <= 239) return 'multicast (224.0.0.0/4)';
  if (a >= 240) return 'reserved (240.0.0.0/4)';
  return null;
}

/** Returns a human-readable reason if the address must not be contacted. */
export function blockedIpReason(ip: string): string | null {
  const bytes = parseIp(ip);
  if (!bytes) return 'not a valid IP address';
  if (bytes.length === 4) return blockedV4Reason([bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!]);

  const b = bytes;
  const v4At = (o: number): V4 => [b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!];
  const zeros = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) if (b[i] !== 0) return false;
    return true;
  };

  // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return blockedV4Reason(v4At(12)) ?? null;
  }
  // ::/96 — unspecified, loopback and deprecated IPv4-compatible addresses.
  if (zeros(0, 12)) return 'unspecified / loopback / IPv4-compatible (::/96)';
  // 64:ff9b::/96 NAT64 — judge by the embedded IPv4 address.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) {
    return blockedV4Reason(v4At(12)) ?? null;
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return 'NAT64 local-use (64:ff9b:1::/48)';
  // 2002::/16 6to4 — embedded IPv4 at bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4Reason(v4At(2)) ?? null;
  // 2001::/32 Teredo, 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'Teredo (2001::/32)';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'documentation (2001:db8::/32)';
  if ((b[0]! & 0xfe) === 0xfc) return 'unique-local (fc00::/7)';
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link-local (fe80::/10)';
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return 'site-local (fec0::/10)';
  if (b[0] === 0xff) return 'multicast (ff00::/8)';
  // Only global unicast 2000::/3 is considered routable.
  if ((b[0]! & 0xe0) !== 0x20) return 'not global unicast (outside 2000::/3)';
  return null;
}

// ---------------------------------------------------------------- host logic

/** Hostnames of the compose services; the base set is always blocked. */
export const DEFAULT_BLOCKED_HOSTS = [
  'localhost',
  '*.localhost',
  '*.local',
  '*.internal',
  '*.localdomain',
  '*.lan',
  'scraper-api',
  'scraper-worker',
  'scraper-redis',
  'redis',
  'nopxus',
  'postgres',
];

function matchesHostRule(host: string, rule: string): boolean {
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1); // ".local"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === rule;
}

export interface Resolver {
  (hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>>;
}

const defaultResolver: Resolver = async (hostname) => {
  const res = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

export interface SsrfGuardOptions {
  /** Extra blocked hosts (the `BLOCKED_HOSTS` env var). */
  blockedHosts?: string[];
  /** Injectable DNS (unit tests). */
  resolver?: Resolver;
  /**
   * TEST ONLY. IPs that are allowed even though they are in a blocked range
   * (e.g. `127.0.0.1` for the local fixture server). The constructor throws
   * unless `NODE_ENV === 'test'`; the production entrypoints never pass it.
   */
  testAllowIps?: string[];
}

export interface ResolvedTarget {
  url: URL;
  hostname: string;
  port: number;
  /** The already-validated address the socket must connect to. */
  address: string;
  family: 4 | 6;
}

export class SsrfGuard {
  private readonly rules: string[];
  private readonly resolver: Resolver;
  private readonly testAllow: Set<string>;

  constructor(opts: SsrfGuardOptions = {}) {
    this.rules = [...DEFAULT_BLOCKED_HOSTS, ...(opts.blockedHosts ?? []).map((h) => h.toLowerCase())];
    this.resolver = opts.resolver ?? defaultResolver;
    this.testAllow = new Set(opts.testAllowIps ?? []);
    if (this.testAllow.size > 0 && process.env.NODE_ENV !== 'test') {
      throw new Error('SsrfGuard: testAllowIps is only permitted when NODE_ENV=test');
    }
  }

  private ipReason(ip: string): string | null {
    if (this.testAllow.has(ip)) return null;
    return blockedIpReason(ip);
  }

  /** Normalizes a URL hostname (lower-case, no brackets, no trailing dot). */
  static normalizeHost(host: string): string {
    let h = host.toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    if (h.endsWith('.')) h = h.slice(0, -1);
    return h;
  }

  /** Synchronous checks: scheme, credentials, host name rules, IP literals. */
  checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SsrfError(`Invalid URL: ${truncate(raw)}`, 'invalid-url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SsrfError(`Scheme not allowed: ${url.protocol}`, 'scheme');
    }
    if (url.username || url.password) {
      throw new SsrfError('URLs with embedded credentials are not allowed', 'credentials');
    }
    this.checkHost(url.hostname);
    return url;
  }

  checkHost(rawHost: string): void {
    const host = SsrfGuard.normalizeHost(rawHost);
    if (!host) throw new SsrfError('Empty host', 'invalid-url');
    const literal = parseIp(host);
    if (literal) {
      const reason = this.ipReason(host);
      if (reason) throw new SsrfError(`Address not allowed: ${host} is ${reason}`, 'blocked-ip');
      return;
    }
    if (this.testAllow.has(host)) return;
    for (const rule of this.rules) {
      if (matchesHostRule(host, rule)) throw new SsrfError(`Host not allowed: ${host}`, 'blocked-host');
    }
    // Single-label names ("scraper-redis", "db") resolve through Docker's
    // embedded DNS to internal services; public hosts always have a dot.
    if (!host.includes('.')) throw new SsrfError(`Host not allowed (single-label name): ${host}`, 'blocked-host');
  }

  /**
   * Resolves `hostname` and fails if ANY returned address is not allowed
   * (a mixed answer is a rebinding signal). Returns the validated addresses.
   */
  async resolveSafe(rawHost: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
    const host = SsrfGuard.normalizeHost(rawHost);
    this.checkHost(host);
    const literal = parseIp(host);
    if (literal) return [{ address: host, family: literal.length === 4 ? 4 : 6 }];

    let addrs: Array<{ address: string; family: 4 | 6 }>;
    try {
      addrs = await this.resolver(host);
    } catch (e) {
      throw new SsrfError(`DNS resolution failed for ${host}: ${(e as Error).message}`, 'dns');
    }
    if (addrs.length === 0) throw new SsrfError(`DNS returned no addresses for ${host}`, 'dns');
    for (const a of addrs) {
      const reason = this.ipReason(a.address);
      if (reason) {
        throw new SsrfError(`Host ${host} resolves to a blocked address (${a.address}: ${reason})`, 'blocked-ip');
      }
    }
    return addrs;
  }

  /** Full validation of a URL, including DNS. */
  async resolveUrl(raw: string): Promise<ResolvedTarget> {
    const url = this.checkUrl(raw);
    const addrs = await this.resolveSafe(url.hostname);
    const first = addrs[0]!;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return { url, hostname: SsrfGuard.normalizeHost(url.hostname), port, address: first.address, family: first.family };
  }

  /** Throws SsrfError unless the URL (and its DNS answer) is acceptable. */
  async assertUrl(raw: string): Promise<void> {
    await this.resolveUrl(raw);
  }
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

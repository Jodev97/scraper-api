import { describe, expect, it } from 'vitest';
import { SsrfError, SsrfGuard, blockedIpReason, parseIp } from '../../src/security/ssrf.js';

const blocked = [
  // IPv4
  '0.0.0.0', '0.1.2.3',
  '127.0.0.1', '127.255.255.254',
  '10.0.0.1', '10.255.255.255',
  '172.16.0.1', '172.31.255.255',
  '192.168.0.1', '192.168.255.255',
  '169.254.169.254', '169.254.0.1',
  '100.64.0.1', '100.127.255.255',
  '224.0.0.1', '239.255.255.255',
  '240.0.0.1', '255.255.255.255',
  '192.0.0.8', '198.18.0.1',
  // IPv6
  '::', '::1',
  'fc00::1', 'fd12:3456::1', 'fdff:ffff::1',
  'fe80::1', 'febf::1',
  'ff02::1',
  '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
  '::ffff:169.254.169.254',
  '64:ff9b::7f00:1', '64:ff9b::a00:1',
  '2002:7f00:1::1', '2002:a9fe:a9fe::1',
  '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  '2001:db8::1',
  '[::1]', 'fe80::1%eth0',
];

const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1',
  '2606:4700:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4009:81f::200e', '64:ff9b::808:808'];

describe('blockedIpReason', () => {
  it.each(blocked)('blocks %s', (ip) => {
    expect(blockedIpReason(ip)).not.toBeNull();
  });
  it.each(allowed)('allows %s', (ip) => {
    expect(blockedIpReason(ip)).toBeNull();
  });
  it('rejects garbage', () => {
    expect(blockedIpReason('not-an-ip')).not.toBeNull();
    expect(parseIp('1.2.3')).toBeNull();
    expect(parseIp('1::2::3')).toBeNull();
  });
});

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];

describe('SsrfGuard.checkUrl', () => {
  const g = new SsrfGuard({ resolver: publicResolver });
  const reject = (url: string, reason?: string) => {
    try {
      g.checkUrl(url);
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfError);
      if (reason) expect((e as SsrfError).reason).toBe(reason);
      return;
    }
    throw new Error(`expected ${url} to be rejected`);
  };

  it('accepts normal http(s) URLs', () => {
    expect(g.checkUrl('https://example.com/a?b=1').hostname).toBe('example.com');
    expect(g.checkUrl('http://example.com:8080/').port).toBe('8080');
  });
  it('rejects non-http schemes', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com', 'javascript:alert(1)', 'data:text/html,hi']) reject(u);
  });
  it('rejects credentials in the URL', () => reject('http://user:pass@example.com/', 'credentials'));
  it('rejects blocked host names', () => {
    for (const u of [
      'http://localhost/', 'http://LOCALHOST:3000/', 'http://localhost./', 'http://foo.localhost/',
      'http://printer.local/', 'http://metadata.google.internal/', 'http://a.b.internal/',
      'http://scraper-redis:6379/', 'http://scraper-api:3000/', 'http://redis/', 'http://somedockerservice/',
    ]) reject(u, 'blocked-host');
  });
  it('rejects IP literals in blocked ranges, including obfuscated forms', () => {
    for (const u of [
      'http://127.0.0.1/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://100.100.100.200/',
    ]) reject(u, 'blocked-ip');
  });
  it('applies configured BLOCKED_HOSTS', () => {
    const g2 = new SsrfGuard({ resolver: publicResolver, blockedHosts: ['evil.example.com', '*.corp.example.com'] });
    expect(() => g2.checkUrl('https://evil.example.com/')).toThrow(SsrfError);
    expect(() => g2.checkUrl('https://x.corp.example.com/')).toThrow(SsrfError);
    expect(() => g2.checkUrl('https://corp.example.com/')).not.toThrow();
  });
});

describe('SsrfGuard DNS handling', () => {
  it('rejects a host that resolves to a private IP', async () => {
    const g = new SsrfGuard({ resolver: async () => [{ address: '10.0.0.5', family: 4 }] });
    await expect(g.resolveUrl('http://innocent.example.com/')).rejects.toMatchObject({ reason: 'blocked-ip' });
  });
  it('rejects a host that resolves to metadata IP / IPv6 ULA / mapped addresses', async () => {
    for (const address of ['169.254.169.254', 'fd00::1', '::ffff:192.168.1.1']) {
      const g = new SsrfGuard({ resolver: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
      await expect(g.resolveUrl('http://x.example.com/')).rejects.toBeInstanceOf(SsrfError);
    }
  });
  it('rejects mixed answers (one public, one private) as a rebinding signal', async () => {
    const g = new SsrfGuard({
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    await expect(g.resolveUrl('http://x.example.com/')).rejects.toBeInstanceOf(SsrfError);
  });
  it('returns the validated address so callers connect to it', async () => {
    const g = new SsrfGuard({ resolver: publicResolver });
    const t = await g.resolveUrl('https://example.com/p');
    expect(t).toMatchObject({ address: '93.184.216.34', family: 4, port: 443, hostname: 'example.com' });
  });
  it('treats DNS failures as rejections', async () => {
    const g = new SsrfGuard({
      resolver: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(g.resolveUrl('http://nope.example.com/')).rejects.toMatchObject({ reason: 'dns' });
  });
  it('re-resolves on every call (no caching that would allow rebinding)', async () => {
    let n = 0;
    const g = new SsrfGuard({
      resolver: async () => [{ address: n++ === 0 ? '93.184.216.34' : '10.0.0.1', family: 4 }],
    });
    await g.resolveUrl('http://rebind.example.com/');
    await expect(g.resolveUrl('http://rebind.example.com/')).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('test-only loopback allowance', () => {
  it('works under NODE_ENV=test and only for the listed IPs', async () => {
    const g = new SsrfGuard({ testAllowIps: ['127.0.0.1'] });
    await expect(g.resolveUrl('http://127.0.0.1:8080/')).resolves.toMatchObject({ address: '127.0.0.1', port: 8080 });
    await expect(g.resolveUrl('http://10.0.0.1/')).rejects.toBeInstanceOf(SsrfError);
    await expect(g.resolveUrl('http://169.254.169.254/')).rejects.toBeInstanceOf(SsrfError);
  });
  it('refuses to exist outside NODE_ENV=test', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new SsrfGuard({ testAllowIps: ['127.0.0.1'] })).toThrow(/NODE_ENV=test/);
      expect(() => new SsrfGuard()).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

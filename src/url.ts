import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

const tracking = /^(utm_[a-z]+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|ref_src)$/i;

export function normalizeUrl(input: string): string {
  const parsed = new URL(input.trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
  if (parsed.username || parsed.password) throw new Error('URLs cannot contain credentials');
  if (parsed.port && !['80', '443'].includes(parsed.port)) throw new Error('Only standard web ports are supported');
  if (parsed.hostname.length > 253) throw new Error('Hostname is too long');
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (tracking.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().range() === 'unicast';
  }
  return parsed.range() === 'unicast';
}

export async function resolvePublicHost(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error('Private network destinations are not allowed');
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new Error('Private network destinations are not allowed');
    return { address: host, family: isIP(host) as 4 | 6 };
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new Error('Private network destinations are not allowed');
  }
  return { address: records[0].address, family: records[0].family as 4 | 6 };
}

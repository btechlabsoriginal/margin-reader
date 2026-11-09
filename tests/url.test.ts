import { describe, expect, it } from 'vitest';
import { isPublicAddress, normalizeUrl, resolvePublicHost } from '../src/url.js';

describe('URL handling', () => {
  it('deduplicates tracking parameters and fragments', () => {
    expect(normalizeUrl(' https://EXAMPLE.com/story?utm_source=mail&b=2&a=1#section '))
      .toBe('https://example.com/story?a=1&b=2');
  });

  it('rejects unsupported protocols, credentials, and unsafe ports', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeUrl('http://admin:secret@example.com/')).toThrow();
    expect(() => normalizeUrl('https://example.com:1234/')).toThrow();
  });

  it('blocks private and reserved addresses', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    await expect(resolvePublicHost('localhost')).rejects.toThrow();
  });
});

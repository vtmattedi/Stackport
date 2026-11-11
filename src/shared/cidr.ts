/** IPv4 CIDR arithmetic, kept to what Stackport needs: parsing, ranges and carving fixed-size subnets. */

export interface Cidr {
  /** First address as an unsigned 32-bit number. */
  start: number;
  prefix: number;
}

export function parseCidr(text: string): Cidr | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;
  const address = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { start: (address & mask) >>> 0, prefix };
}

/** Last address of the range. */
export const cidrEnd = (c: Cidr): number => c.start + 2 ** (32 - c.prefix) - 1;

export function formatCidr(c: Cidr): string {
  const octets = [c.start >>> 24, (c.start >>> 16) & 255, (c.start >>> 8) & 255, c.start & 255];
  return `${octets.join(".")}/${c.prefix}`;
}

/** The index-th subnet of the given prefix length inside `range`, or null when the range is too small,
 *  the prefix is not longer than the range's, or the index is out of bounds. */
export function nthSubnet(range: string, prefix: number, index: number): string | null {
  const base = parseCidr(range);
  if (!base || !Number.isInteger(index) || index < 0 || prefix <= base.prefix || prefix > 30) return null;
  const size = 2 ** (32 - prefix);
  const start = base.start + index * size;
  if (start + size - 1 > cidrEnd(base)) return null;
  return formatCidr({ start, prefix });
}

/** Whether two ranges share an address. */
export function cidrsOverlap(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  if (!x || !y) return false;
  return x.start <= cidrEnd(y) && y.start <= cidrEnd(x);
}

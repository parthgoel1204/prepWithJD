import { isIP } from "node:net";

export interface UrlVerdict {
  ok: boolean;
  url?: URL;
  code?: string;
  message?: string;
}

const PRIVATE_IPV4_BLOCKS: Array<[number, number]> = [
  [0x0a000000, 0x0a000000 | 0x00ffffff], // 10.0.0.0/8
  [0x7f000000, 0x7f000000 | 0x00ffffff], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xa9fe0000 | 0x0000ffff], // 169.254.0.0/16 link-local
  [0xac100000, 0xac100000 | 0x000fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a80000 | 0x0000ffff], // 192.168.0.0/16
];

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const value =
    (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
  return PRIVATE_IPV4_BLOCKS.some(([start, end]) => value >= start && value <= end);
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  // ::1 loopback, fc00::/7 unique-local, fe8-feB link-local, ::ffff: mapped v4
  if (lower.startsWith("::1") || lower.startsWith("::ffff:") || /^fe[89ab]/.test(lower) || /^f[cd]/.test(lower)) {
    return true;
  }
  // LINX test-network 2001:db8::/32 is documentation-only
  return lower.startsWith("2001:db8:");
}

function isPrivateHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return true;
  }
  const ipVersion = isIP(lower);
  if (ipVersion === 4) return isPrivateIpv4(lower);
  if (ipVersion === 6) return isPrivateIpv6(lower);
  return false;
}

/**
 * Validate a URL before fetching. In production this rejects private/loopback IPs and
 * hostnames, non-http(s) schemes, embedded credentials, and non-standard ports.
 *
 * The same check is re-applied to the FINAL url after any redirects.
 */
export function checkUrl(
  raw: string,
  opts: { allowPrivateUrls: boolean; isProduction: boolean } = {
    allowPrivateUrls: true,
    isProduction: process.env.NODE_ENV === "production",
  },
): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: "INVALID_URL", message: "URL could not be parsed" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "PROTOCOL_REJECTED", message: `Only http/https are allowed (got ${url.protocol})` };
  }

  if (url.username || url.password) {
    return { ok: false, code: "CREDENTIALS_REJECTED", message: "URLs with embedded credentials are rejected" };
  }

  if (opts.isProduction && !opts.allowPrivateUrls && isPrivateHostname(url.hostname)) {
    return { ok: false, code: "PRIVATE_URL_REJECTED", message: `Private/loopback host rejected in production: ${url.hostname}` };
  }

  if (opts.isProduction && url.port !== "" && url.port !== "80" && url.port !== "443") {
    return { ok: false, code: "PORT_REJECTED", message: `Non-standard port rejected in production: ${url.port}` };
  }

  return { ok: true, url };
}
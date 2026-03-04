interface DnsAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DnsResponse {
  Status: number;
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
  Question: Array<{ name: string; type: number }>;
  Answer: DnsAnswer[];
}

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DNS_CACHE = new Map<string, { ip: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function queryDoH(
  hostname: string,
  type: 'A' | 'AAAA' = 'A',
): Promise<string | null> {
  const typeMap: Record<string, number> = { A: 1, AAAA: 28 };

  const url = new URL(DOH_ENDPOINT);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', String(typeMap[type]));
  url.searchParams.set('do', 'false'); // Don't return DNSSEC records

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/dns-json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as DnsResponse;

    if (data.Status !== 0) {
      throw new Error(`DNS error: ${data.Status}`);
    }

    if (!data.Answer || data.Answer.length === 0) {
      return null;
    }

    for (const answer of data.Answer) {
      if (answer.type === typeMap[type]) {
        return answer.data;
      }
    }

    return null;
  } catch (error) {
    throw new Error(
      `DoH query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function resolveHostname(hostname: string): Promise<string> {
  const cached = DNS_CACHE.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ip;
  }

  let ip: string | null = null;

  try {
    ip = await queryDoH(hostname, 'A');
  } catch (error) {
    throw new Error(
      `Failed to resolve ${hostname} via DoH: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!ip) {
    throw new Error(`No A record found for ${hostname}`);
  }

  DNS_CACHE.set(hostname, {
    ip,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return ip;
}

export function clearCache(): void {
  DNS_CACHE.clear();
}

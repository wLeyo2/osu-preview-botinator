#!/usr/bin/env bun
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

interface DiagnosticResult {
  test: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
  message: string;
  details?: string;
}

const results: DiagnosticResult[] = [];

function log(...args: unknown[]) {
  console.log(...args);
}

function record(
  test: string,
  status: DiagnosticResult['status'],
  message: string,
  details?: string,
) {
  const result: DiagnosticResult = { test, status, message, details };
  results.push(result);

  const statusEmoji = { PASS: '✓', FAIL: '✗', WARN: '⚠', SKIP: '⊘' }[status];
  console.log(`${statusEmoji} ${test}: ${message}`);
  if (details) {
    console.log(`  ${details}`);
  }
}

async function checkDnsResolution(hostname: string) {
  const testName = `DNS Resolution: ${hostname}`;
  try {
    const result = await dnsLookup(hostname);
    record(
      testName,
      'PASS',
      `Resolved to ${result.address}`,
      `Family: IPv${result.family}`,
    );
  } catch (error) {
    record(
      testName,
      'FAIL',
      `DNS lookup failed`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function checkConnectivity(url: string) {
  const testName = `HTTP Connectivity: ${url}`;
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      record(testName, 'PASS', `HTTP ${response.status}`);
    } else {
      record(
        testName,
        'FAIL',
        `HTTP ${response.status} ${response.statusText}`,
        `Server returned non-OK status`,
      );
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (errorMsg.includes('ECONNREFUSED')) {
      record(
        testName,
        'FAIL',
        'Connection refused',
        'Port may be blocked or service down',
      );
    } else if (errorMsg.includes('ETIMEDOUT')) {
      record(
        testName,
        'FAIL',
        'Connection timeout',
        'Network route may be blocked or slow',
      );
    } else if (errorMsg.includes('ENOTFOUND')) {
      record(testName, 'FAIL', 'Host not found', 'DNS resolution failed');
    } else if (errorMsg.includes('CERT_')) {
      record(testName, 'FAIL', 'SSL/TLS certificate error', errorMsg);
    } else {
      record(testName, 'FAIL', 'Connection failed', errorMsg);
    }
  }
}

async function checkCurlConnectivity(url: string) {
  const testName = `Curl Connectivity: ${url}`;
  try {
    const { stdout, stderr } = await execAsync(
      `curl -I -s -m 10 --connect-timeout 5 "${url}" 2>&1 | head -n 1`,
      { timeout: 15000 },
    );

    if (stdout.trim().startsWith('HTTP/')) {
      record(testName, 'PASS', `Curl: ${stdout.trim()}`);
    } else {
      record(
        testName,
        'WARN',
        'Curl returned unexpected output',
        stdout || stderr,
      );
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (errorMsg.includes('timed out') || errorMsg.includes('Timeout')) {
      record(
        testName,
        'FAIL',
        'Curl: Connection timeout',
        'Curl could not connect within timeout',
      );
    } else if (errorMsg.includes('Connection refused')) {
      record(
        testName,
        'FAIL',
        'Curl: Connection refused',
        'Port may be blocked',
      );
    } else if (errorMsg.includes('Could not resolve host')) {
      record(
        testName,
        'FAIL',
        'Curl: DNS resolution failed',
        'Could not resolve hostname',
      );
    } else {
      record(testName, 'FAIL', 'Curl: Error', errorMsg);
    }
  }
}

async function checkLocalNetwork() {
  const testName = 'Local Network Info';
  try {
    const platform = process.platform;

    if (platform === 'linux') {
      const { stdout } = await execAsync(
        'ip route show default 2>/dev/null || route -n | grep UG 2>/dev/null',
      );
      record(
        testName,
        'PASS',
        'Default route detected',
        stdout.trim() || 'Route info available',
      );
    } else if (platform === 'darwin') {
      const { stdout } = await execAsync('netstat -nr | grep default');
      record(testName, 'PASS', 'Default route detected', stdout.trim());
    } else {
      record(
        testName,
        'SKIP',
        `Platform ${platform} not supported for network check`,
      );
    }
  } catch (error) {
    record(
      testName,
      'WARN',
      'Could not get network info',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function checkFirewall() {
  const testName = 'Firewall Status';
  try {
    const platform = process.platform;

    if (platform === 'linux') {
      try {
        const { stdout: ufw } = await execAsync(
          'ufw status 2>/dev/null || echo "not installed"',
        );
        if (!ufw.includes('not installed')) {
          record(
            testName,
            'WARN',
            'UFW firewall detected',
            ufw.split('\n').find((line) => line.includes('Status')) ||
              'Check UFW rules',
          );
        } else {
          try {
            const { stdout: firewalld } = await execAsync(
              'firewall-cmd --state 2>&1 || echo "not running"',
            );
            if (firewalld.includes('running')) {
              record(
                testName,
                'WARN',
                'firewalld is running',
                'Check firewalld rules',
              );
            } else {
              record(testName, 'PASS', 'No active firewall detected');
            }
          } catch {
            record(testName, 'PASS', 'No active firewall detected');
          }
        }
      } catch {
        record(testName, 'SKIP', 'Could not determine firewall status');
      }
    } else {
      record(
        testName,
        'SKIP',
        `Platform ${platform} not supported for firewall check`,
      );
    }
  } catch (error) {
    record(
      testName,
      'WARN',
      'Could not check firewall',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function checkProxy() {
  const testName = 'Proxy Environment';
  const proxyVars = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
  ];
  const found = proxyVars.filter((key) => process.env[key]);

  if (found.length > 0) {
    const vars = found.map((key) => `${key}=${process.env[key]}`).join(', ');
    record(testName, 'WARN', `Proxy environment variables detected`, vars);
  } else {
    record(testName, 'PASS', 'No proxy environment variables detected');
  }
}

async function checkNodeVersion() {
  const testName = 'Runtime Info';
  record(
    testName,
    'PASS',
    `Bun ${process.version} on ${process.platform}/${process.arch}`,
    `Node compat: ${typeof Bun !== 'undefined'}`,
  );
}

function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('DIAGNOSTIC SUMMARY');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const warned = results.filter((r) => r.status === 'WARN').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;

  console.log(
    `\nTotal: ${results.length} | ✓ ${passed} | ✗ ${failed} | ⚠ ${warned} | ⊘ ${skipped}\n`,
  );

  if (failed > 0) {
    console.log('FAILURES:');
    results
      .filter((r) => r.status === 'FAIL')
      .forEach((r) => {
        console.log(`  - ${r.test}: ${r.message}`);
        if (r.details) {
          console.log(`    ${r.details}`);
        }
      });
  }

  console.log('\nRECOMMENDATIONS:');

  const hasConnectivityFail = results.some(
    (r) => r.status === 'FAIL' && r.test.includes('Connectivity'),
  );
  const hasDnsFail = results.some(
    (r) => r.status === 'FAIL' && r.test.includes('DNS'),
  );
  const hasFirewallWarn = results.some(
    (r) => r.status === 'WARN' && r.test.includes('Firewall'),
  );
  const hasProxyWarn = results.some(
    (r) => r.status === 'WARN' && r.test.includes('Proxy'),
  );

  if (hasDnsFail) {
    console.log(
      '  1. Try using different DNS servers (e.g., 8.8.8.8, 1.1.1.1)',
    );
  }

  if (hasConnectivityFail) {
    console.log(
      '  2. Check your local firewall rules for outbound HTTPS (443)',
    );
    console.log('  3. Try disabling VPN or proxy temporarily');
    console.log('  4. Test from a different network (e.g., mobile hotspot)');
  }

  if (hasFirewallWarn) {
    console.log(
      '  5. Verify firewall allows outbound HTTPS to *.r2.cloudflarestorage.com',
    );
  }

  if (hasProxyWarn) {
    console.log(
      '  6. Ensure Node.js/Bun can use your proxy if one is configured',
    );
  }

  if (!hasConnectivityFail && !hasDnsFail) {
    console.log('  - Basic connectivity appears OK. The issue may be:');
    console.log('    1. R2 credentials misconfiguration');
    console.log('    2. AWS signature calculation issue');
    console.log(
      '    3. Node.js/Bun fetch() implementation specific to this endpoint',
    );
  }

  console.log('\nNEXT STEPS:');
  console.log(
    "  - If curl works but Node.js fails, it's a language/library issue",
  );
  console.log("  - If both fail, it's a network/firewall issue");
  console.log(
    '  - Check the actual error message in your application logs for more detail',
  );
  console.log();
}

async function main() {
  console.log('='.repeat(60));
  console.log('R2 CONNECTIVITY DIAGNOSTIC TOOL');
  console.log('='.repeat(60));
  console.log();

  const R2_ENDPOINT =
    'https://8d8dc787cf8713fa3df18d38c65bf7f0.r2.cloudflarestorage.com';
  const R2_PUBLIC_URL = 'https://pub-7d7a779421d44da3844fa0126a778d33.r2.dev';
  const R2_HOSTNAME =
    '8d8dc787cf8713fa3df18d38c65bf7f0.r2.cloudflarestorage.com';
  const CLOUDFLARE_TEST = 'https://1.1.1.1';
  const GOOGLE_DNS = 'https://8.8.8.8';

  await checkNodeVersion();
  await checkProxy();

  console.log('\n--- DNS Tests ---');
  await checkDnsResolution(R2_HOSTNAME);
  await checkDnsResolution('cloudflare.com');

  console.log('\n--- Basic Connectivity Tests ---');
  await checkConnectivity(CLOUDFLARE_TEST);
  await checkConnectivity(GOOGLE_DNS);
  await checkConnectivity('https://cloudflare.com');

  console.log('\n--- R2-Specific Tests ---');
  await checkConnectivity(R2_PUBLIC_URL);
  await checkConnectivity(R2_ENDPOINT);

  console.log('\n--- System Network Tests ---');
  await checkLocalNetwork();
  await checkFirewall();

  console.log('\n--- curl Comparison Tests ---');
  await checkCurlConnectivity(R2_PUBLIC_URL);
  await checkCurlConnectivity(R2_ENDPOINT);

  printSummary();
}

main().catch((error) => {
  console.error('Diagnostic script failed:', error);
  process.exit(1);
});

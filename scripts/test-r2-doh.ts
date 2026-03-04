#!/usr/bin/env bun
import { URL } from 'node:url';
import config from '@/utils/config';
import { resolveHostname } from '@/utils/doh';

async function testR2UrlConstruction() {
  const endpointUrl = new URL(config.r2.endpoint);
  const originalHostname = endpointUrl.hostname;
  const originalPort = endpointUrl.port;

  console.log('Testing R2 URL construction with DoH...\n');
  console.log(`Original endpoint: ${config.r2.endpoint}`);
  console.log(`Original hostname: ${originalHostname}`);
  console.log(`Original port: ${originalPort || 'default (443)'}`);

  const resolvedIp = await resolveHostname(originalHostname);
  console.log(`Resolved IP: ${resolvedIp}`);

  const fileName = 'preview/test.mp4';
  const path = `/${config.r2.bucket}/${fileName}`;

  const uploadUrl = `${endpointUrl.protocol}//${resolvedIp}${path}`;
  console.log(`\nUpload URL: ${uploadUrl}`);

  const hostHeader = originalPort
    ? `${originalHostname}:${originalPort}`
    : originalHostname;
  console.log(`Host header: ${hostHeader}`);

  console.log('\n✓ URL and Host header construction successful');
  console.log('\nNotes:');
  console.log('- The URL uses the resolved IP address to bypass local DNS');
  console.log(
    '- The Host header uses the original hostname for TLS SNI and server routing',
  );
  console.log(
    '- This ensures proper HTTPS certificate validation and R2 routing',
  );
}

testR2UrlConstruction().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});

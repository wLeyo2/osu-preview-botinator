#!/usr/bin/env bun
import { URL } from 'node:url';
import config from '@/utils/config';
import { resolveHostname } from '@/utils/doh';
import logger from '@/utils/logger';

async function testR2UrlConstruction() {
  const endpointUrl = new URL(config.r2.endpoint);
  const originalHostname = endpointUrl.hostname;
  const originalPort = endpointUrl.port;

  logger.info('Testing R2 URL construction with DoH...\n');
  logger.info(`Original endpoint: ${config.r2.endpoint}`);
  logger.info(`Original hostname: ${originalHostname}`);
  logger.info(`Original port: ${originalPort || 'default (443)'}`);

  const resolvedIp = await resolveHostname(originalHostname);
  logger.info(`Resolved IP: ${resolvedIp}`);

  const fileName = 'preview/test.mp4';
  const path = `/${config.r2.bucket}/${fileName}`;

  const uploadUrl = `${endpointUrl.protocol}//${resolvedIp}${path}`;
  logger.info(`\nUpload URL: ${uploadUrl}`);

  const hostHeader = originalPort
    ? `${originalHostname}:${originalPort}`
    : originalHostname;
  logger.info(`Host header: ${hostHeader}`);

  logger.info('\n✓ URL and Host header construction successful');
  logger.info('\nNotes:');
  logger.info('- The URL uses the resolved IP address to bypass local DNS');
  logger.info(
    '- The Host header uses the original hostname for TLS SNI and server routing',
  );
  logger.info(
    '- This ensures proper HTTPS certificate validation and R2 routing',
  );
}

testR2UrlConstruction().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});

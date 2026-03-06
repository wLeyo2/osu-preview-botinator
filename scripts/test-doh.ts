#!/usr/bin/env bun
import { resolveHostname } from '@/utils/doh';
import logger from '@/utils/logger';

async function testDoH() {
  const hostname = '8d8dc787cf8713fa3df18d38c65bf7f0.r2.cloudflarestorage.com';

  logger.info(`Testing DoH resolution for ${hostname}...`);

  try {
    const ip = await resolveHostname(hostname);
    logger.info(`✓ Resolved ${hostname} to ${ip}`);
  } catch (error) {
    console.error(`✗ Failed to resolve ${hostname}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const publicHostname = 'pub-7d7a779421d44da3844fa0126a778d33.r2.dev';
  logger.info(`\nTesting DoH resolution for ${publicHostname}...`);

  try {
    const ip = await resolveHostname(publicHostname);
    logger.info(`✓ Resolved ${publicHostname} to ${ip}`);
  } catch (error) {
    console.error(`✗ Failed to resolve ${publicHostname}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

testDoH();

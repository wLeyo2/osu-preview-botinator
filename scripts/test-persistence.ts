#!/usr/bin/env bun
import logger from '@/utils/logger';
import { getScrollMs, setScrollMs } from '@/utils/osu/scrollSpeed';
import {
  getUserPrefs,
  setNoteStyle,
  setScrollDirection,
} from '@/utils/osu/userPrefs';

async function testPersistence() {
  const testUserId = `test-user-${Date.now()}`;
  logger.info(`Testing persistence with user ID: ${testUserId}\n`);

  logger.info('1. Getting initial preferences (should be defaults)...');
  const initialPrefs = await getUserPrefs(testUserId);
  logger.info(`   noteStyle: ${initialPrefs.noteStyle}`);
  logger.info(`   scrollDirection: ${initialPrefs.scrollDirection}`);
  logger.info(`   renderMode: ${initialPrefs.renderMode}`);

  logger.info('\n2. Getting initial scroll speed (should be default)...');
  const initialScroll = await getScrollMs(testUserId);
  logger.info(`   scrollMs: ${initialScroll}`);

  logger.info('\n3. Setting noteStyle to "circle"...');
  await setNoteStyle(testUserId, 'circle');

  logger.info('4. Setting scrollDirection to "up"...');
  await setScrollDirection(testUserId, 'up');

  logger.info('5. Setting scroll speed to 450ms...');
  await setScrollMs(testUserId, 450);

  logger.info('\n6. Getting updated preferences...');
  const updatedPrefs = await getUserPrefs(testUserId);
  logger.info(`   noteStyle: ${updatedPrefs.noteStyle}`);
  logger.info(`   scrollDirection: ${updatedPrefs.scrollDirection}`);

  logger.info('\n7. Getting updated scroll speed...');
  const updatedScroll = await getScrollMs(testUserId);
  logger.info(`   scrollMs: ${updatedScroll}`);

  logger.info('\n8. Checking in-memory cache consistency...');
  const prefsAgain = await getUserPrefs(testUserId);
  const scrollAgain = await getScrollMs(testUserId);
  logger.info(`   noteStyle (from cache): ${prefsAgain.noteStyle}`);
  logger.info(`   scrollMs (from cache): ${scrollAgain}`);

  if (
    prefsAgain.noteStyle === 'circle' &&
    prefsAgain.scrollDirection === 'up' &&
    scrollAgain === 450
  ) {
    logger.info('\n✓ All tests passed! Persistence is working correctly.');
    logger.info(
      '\nNote: Settings should persist in Redis even after bot restart.',
    );
  } else {
    logger.info('\n✗ Tests failed! Values do not match.');
  }
}

testPersistence().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});

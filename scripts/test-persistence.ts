#!/usr/bin/env bun
import { getScrollMs, setScrollMs } from '@/utils/osu/scrollSpeed';
import {
  getUserPrefs,
  setNoteStyle,
  setScrollDirection,
} from '@/utils/osu/userPrefs';

async function testPersistence() {
  const testUserId = `test-user-${Date.now()}`;
  console.log(`Testing persistence with user ID: ${testUserId}\n`);

  console.log('1. Getting initial preferences (should be defaults)...');
  const initialPrefs = await getUserPrefs(testUserId);
  console.log(`   noteStyle: ${initialPrefs.noteStyle}`);
  console.log(`   scrollDirection: ${initialPrefs.scrollDirection}`);
  console.log(`   renderMode: ${initialPrefs.renderMode}`);

  console.log('\n2. Getting initial scroll speed (should be default)...');
  const initialScroll = await getScrollMs(testUserId);
  console.log(`   scrollMs: ${initialScroll}`);

  console.log('\n3. Setting noteStyle to "circle"...');
  await setNoteStyle(testUserId, 'circle');

  console.log('4. Setting scrollDirection to "up"...');
  await setScrollDirection(testUserId, 'up');

  console.log('5. Setting scroll speed to 450ms...');
  await setScrollMs(testUserId, 450);

  console.log('\n6. Getting updated preferences...');
  const updatedPrefs = await getUserPrefs(testUserId);
  console.log(`   noteStyle: ${updatedPrefs.noteStyle}`);
  console.log(`   scrollDirection: ${updatedPrefs.scrollDirection}`);

  console.log('\n7. Getting updated scroll speed...');
  const updatedScroll = await getScrollMs(testUserId);
  console.log(`   scrollMs: ${updatedScroll}`);

  console.log('\n8. Checking in-memory cache consistency...');
  const prefsAgain = await getUserPrefs(testUserId);
  const scrollAgain = await getScrollMs(testUserId);
  console.log(`   noteStyle (from cache): ${prefsAgain.noteStyle}`);
  console.log(`   scrollMs (from cache): ${scrollAgain}`);

  if (
    prefsAgain.noteStyle === 'circle' &&
    prefsAgain.scrollDirection === 'up' &&
    scrollAgain === 450
  ) {
    console.log('\n✓ All tests passed! Persistence is working correctly.');
    console.log(
      '\nNote: Settings should persist in Redis even after bot restart.',
    );
  } else {
    console.log('\n✗ Tests failed! Values do not match.');
  }
}

testPersistence().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSLATIONS,
  SUPPORTED_LOCALES,
  detectBrowserLocale,
  partitionConnectors,
  reorderConnectors,
  moveConnectorByIndex,
} from './i18n';
import type { SocialConnector } from '../types';

test('All 5 locales contain identical complete translation keys with non-empty values', () => {
  const baseKeys = Object.keys(TRANSLATIONS['en']).sort();
  assert.equal(SUPPORTED_LOCALES.length, 5);
  for (const { code } of SUPPORTED_LOCALES) {
    const localeKeys = Object.keys(TRANSLATIONS[code]).sort();
    assert.deepEqual(localeKeys, baseKeys, `Key mismatch in locale ${code}`);
    for (const k of baseKeys) {
      const val = TRANSLATIONS[code][k as keyof typeof TRANSLATIONS['en']];
      assert.equal(typeof val, 'string');
      assert.ok(val.trim().length > 0, `Empty translation for ${code}.${k}`);
    }
  }
});

test('detectBrowserLocale resolves Simplified, Traditional, Japanese, German, and English', () => {
  assert.equal(detectBrowserLocale('zh-CN'), 'zh-CN');
  assert.equal(detectBrowserLocale('zh-TW'), 'zh-TW');
  assert.equal(detectBrowserLocale('zh-HK'), 'zh-TW');
  assert.equal(detectBrowserLocale('ja-JP'), 'ja');
  assert.equal(detectBrowserLocale('de-DE'), 'de');
  assert.equal(detectBrowserLocale('fr-FR'), 'en');
});

test('partitionConnectors collapses enabled connectors past threshold into overflow', () => {
  const make = (id: string, enabled: boolean): SocialConnector => ({
    id,
    provider: 'github',
    displayName: id,
    enabled,
    clientId: 'cid',
    hasSecret: true,
    secretMasked: '••••',
    extra: {},
    updatedAt: '2026-11-24T00:00:00Z',
  });

  const connectors = [
    make('microsoft', true),
    make('apple', true),
    make('google', true),
    make('wechat', true),
    make('github', true),
    make('disabled_one', false),
  ];

  const { primary, overflow } = partitionConnectors(connectors, 3);
  assert.equal(primary.length, 3);
  assert.equal(overflow.length, 2);
  assert.deepEqual(primary.map((c) => c.id), ['microsoft', 'apple', 'google']);
  assert.deepEqual(overflow.map((c) => c.id), ['wechat', 'github']);
});

test('reorderConnectors & moveConnectorByIndex safely reorder login display order', () => {
  const items = [{ id: 'ms' }, { id: 'apple' }, { id: 'google' }, { id: 'wechat' }, { id: 'github' }];

  const moved = moveConnectorByIndex(items, 3, 0);
  assert.deepEqual(moved.map((i) => i.id), ['wechat', 'ms', 'apple', 'google', 'github']);

  const reordered = reorderConnectors(items, ['github', 'wechat', 'unknown_id', 'github']);
  assert.deepEqual(reordered.map((i) => i.id), ['github', 'wechat', 'ms', 'apple', 'google']);
});

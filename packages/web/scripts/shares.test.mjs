import assert from 'node:assert/strict'
import { test } from 'node:test'

import { expiryLabel, rawFileHref, shareHref } from '../src/utils/shares.ts'

test('the raw link carries the path as a query, encoded', () => {
  assert.equal(rawFileHref('/workspace/四格 图.png'), '/api/files/raw?path=%2Fworkspace%2F%E5%9B%9B%E6%A0%BC+%E5%9B%BE.png')
  assert.equal(rawFileHref('/w/a.html', true), '/api/files/raw?path=%2Fw%2Fa.html&download=1')
})

test('a share link is on the address the page was opened at, with the name last', () => {
  assert.equal(
    shareHref({ token: 'k3J9abcdefghijklmnopqr', name: 'four panel.png' }, 'https://claude.gpunull.dpdns.org'),
    'https://claude.gpunull.dpdns.org/share/k3J9abcdefghijklmnopqr/four%20panel.png',
  )
})

test('expiry reads in the largest unit that fits', () => {
  const now = 1_000_000_000
  assert.equal(expiryLabel({ expiresAt: null }, now), '永久有效')
  assert.equal(expiryLabel({ expiresAt: now + 30 * 60_000 }, now), '30 分钟后失效')
  assert.equal(expiryLabel({ expiresAt: now + 5 * 3_600_000 }, now), '5 小时后失效')
  assert.equal(expiryLabel({ expiresAt: now + 7 * 86_400_000 }, now), '7 天后失效')
  assert.equal(expiryLabel({ expiresAt: now - 1 }, now), '已失效')
})

import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRelease } from '../scripts/prepare-release.js';

test('release notes include only the exact version section, preserving nested headings', () => {
  const release = prepareRelease({
    tag: 'v0.3.0', version: '0.3.0',
    changelog: '# 版本记录\r\n\r\n## 未发布\r\n\r\nFuture work.\r\n\r\n## 0.3.0 — 2026-10-27\r\n\r\nCurrent changes. [Guide](docs/usage.md#example) [External](https://example.com)\r\n\r\n### 限制\r\n\r\nExperimental.\r\n\r\n## 0.2.0 — 2026-10-27\r\n\r\nOld changes.\r\n',
  });
  assert.equal(release.prerelease, false);
  assert.match(release.notes, /Current changes\./);
  assert.match(release.notes, /### 限制\n\nExperimental\./);
  assert.match(release.notes, /NotionSI-win-x64\.zip/);
  assert.match(release.notes, /\[Guide\]\(https:\/\/github.com\/LamborGitted\/NotionSI\/blob\/v0.3.0\/docs\/usage.md#example\)/);
  assert.match(release.notes, /\[External\]\(https:\/\/example.com\)/);
  assert.doesNotMatch(release.notes, /Future work|Old changes/);
});

test('release validation rejects mismatched tags and absent or empty version notes', () => {
  const base = { tag: 'v0.3.0', version: '0.3.0', changelog: '## 0.3.0\n\nChanges.\n' };
  for (const tag of ['v0.2.0', '0.3.0', 'v0.3.0-rc.1', '', 'v0.3.0\n']) {
    assert.throws(() => prepareRelease({ ...base, tag }), /must match/);
  }
  assert.throws(() => prepareRelease({ ...base, changelog: '## 0.3.01\n\nOther version.\n' }), /missing/);
  assert.throws(() => prepareRelease({ ...base, changelog: '## 0.3.0\n\n## 0.2.0\n\nOld.\n' }), /empty/);
});

test('prerelease tags are detected only when package version matches', () => {
  const release = prepareRelease({ tag: 'v0.4.0-rc.1', version: '0.4.0-rc.1', changelog: '## 0.4.0-rc.1 — 2026-10-27\n\nPreview.\n' });
  assert.equal(release.prerelease, true);
  assert.match(release.notes, /^# NotionSI v0\.4\.0-rc\.1/);
});

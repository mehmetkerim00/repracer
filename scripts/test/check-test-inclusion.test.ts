import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error — модуль .mjs без объявлений типов
import { findUnincludedTests } from '../check-test-inclusion.mjs';

/** Р-89, Р-93: проверка полноты сборки проверяется поведением — на синтетическом репозитории, где файл забыт. */

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'repracer-inclusion-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const pkg = (test: string) => JSON.stringify({ name: 'p', scripts: { test } });

test('a test file that no script runs is reported; an explicitly listed file and a glob count as included', () => {
  const root = repo({
    'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { 'test:repo': 'node --test scripts/test/*.test.ts' } }),
    'packages/a/package.json': pkg('node --test test/store.pg.test.ts test/step14.pg.test.ts'),
    'packages/a/test/store.pg.test.ts': '', 'packages/a/test/step14.pg.test.ts': '',
    'packages/a/test/write-recheck.pg.test.ts': '',
    'packages/b/package.json': pkg('node --test src/*.test.ts'),
    'packages/b/src/x.test.ts': '', 'packages/b/src/y.test.ts': '',
    'packages/c/package.json': JSON.stringify({ name: 'c' }),
    'packages/c/src/orphan.test.ts': '',
    'scripts/test/self.test.ts': '',
    'packages/a/node_modules/dep/z.test.ts': '',
  });
  try {
    const result = findUnincludedTests(root);
    assert.equal(result.total, 7);
    assert.deepEqual(result.unincluded.sort(), ['packages/a/test/write-recheck.pg.test.ts', 'packages/c/src/orphan.test.ts']);
    assert.deepEqual(result.listedButMissing, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a script naming a file that does not exist is reported, so a renamed test cannot silently drop out', () => {
  const root = repo({
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/a/package.json': pkg('node --test test/renamed.pg.test.ts test/kept.test.ts'),
    'packages/a/test/kept.test.ts': '',
  });
  try {
    assert.deepEqual(findUnincludedTests(root).listedButMissing, ['packages/a: test/renamed.pg.test.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('step 17: .test.tsx, .test.cts and .test.cjs count as tests; a test under a nested build directory is not skipped; git-ignored output is', () => {
  const root = repo({
    'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
    '.gitignore': 'dist/\n',
    'apps/web/package.json': pkg('node --test src/*.test.ts'),
    'apps/web/src/a.test.ts': '', 'apps/web/src/screen.test.tsx': '', 'apps/web/src/legacy.test.cjs': '', 'apps/web/src/types.test.cts': '',
    'apps/web/src/build/nested.test.ts': '',
    'apps/web/dist/compiled.test.js': '',
  });
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const result = findUnincludedTests(root);
    assert.deepEqual(result.unincluded.sort(), ['apps/web/src/build/nested.test.ts', 'apps/web/src/legacy.test.cjs', 'apps/web/src/screen.test.tsx', 'apps/web/src/types.test.cts']);
    assert.equal(result.all.includes('apps/web/dist/compiled.test.js'), false, 'git-ignored build output is not a source test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real repository has every test file in the build', () => {
  const { total, unincluded, listedButMissing } = findUnincludedTests(join(import.meta.dirname, '..', '..'));
  assert.ok(total > 30);
  assert.deepEqual(unincluded, []);
  assert.deepEqual(listedButMissing, []);
});

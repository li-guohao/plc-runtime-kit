import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertSqliteAvailable } from '../src/sqlite-guard.js';

const [major, minor] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));
const supportsSqlite = major > 22 || (major === 22 && minor >= 5);

/** A stand-in for `node:sqlite` so these checks never need the real module. */
const standIn = { DatabaseSync: function DatabaseSync() {} };

test('the guard accepts 22.5 and newer, comparing numerically', () => {
  for (const version of ['22.5.0', '22.5.10', '23.0.0', '24.19.1']) {
    assert.equal(assertSqliteAvailable(version, () => standIn), standIn, version);
  }
});

test('the guard rejects an old version and names minimum, version and fallback', () => {
  let probed = false;
  assert.throws(
    () =>
      assertSqliteAvailable('22.4.9', () => {
        probed = true;
        return standIn;
      }),
    (error) => {
      assert.match(error.message, /requires Node >= 22\.5/);
      assert.match(error.message, /this process is Node 22\.4\.9/);
      assert.match(error.message, /plc-runtime-kit\/memory/);
      assert.match(error.message, /this Node version is too old/);
      return true;
    },
  );
  // A version that is already ruled out must not probe the module: the guard
  // is a specific version check, not a catch-all around the import.
  assert.equal(probed, false);
});

test('the guard reports a failed module load but keeps version and fallback', () => {
  assert.throws(
    () => assertSqliteAvailable('24.0.0', () => undefined),
    /Node >= 22\.5.*this process is Node 24\.0\.0.*plc-runtime-kit\/memory/s,
  );
});

test('the guard rejects a malformed version instead of guessing', () => {
  for (const version of ['', 'twenty', '22', '22.x']) {
    assert.throws(() => assertSqliteAvailable(version, () => standIn), /requires Node >= 22\.5/);
  }
});

test('importing the sqlite subpath behaves exactly as the guard says', () => {
  // A child process is the only honest probe here: importing the module in this
  // process would either work or fail before this test could inspect anything.
  const moduleUrl = new URL('../src/sqlite.js', import.meta.url).href;
  const script = `
    import(${JSON.stringify(moduleUrl)}).then(
      () => console.log('import ok'),
      (error) => {
        console.error(error.message);
        process.exit(1);
      },
    );
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  const stdout = (child.stdout ?? '').trim();
  const stderr = (child.stderr ?? '').trim();
  console.log(`probe: node ${process.versions.node} -> status ${child.status}`);

  if (supportsSqlite) {
    assert.equal(child.status, 0, stderr);
    assert.equal(stdout, 'import ok');
    return;
  }
  assert.notEqual(child.status, undefined);
  assert.notEqual(child.status, 0, `import unexpectedly succeeded:\n${stdout}`);
  assert.match(stderr, /requires Node >= 22\.5/);
  assert.match(
    stderr,
    new RegExp(`this process is Node ${process.versions.node.replaceAll('.', '\\.')}`),
    `the real version must be in the message, got:\n${stderr}`,
  );
  assert.match(stderr, /plc-runtime-kit\/memory/, 'the fallback must be named');
});

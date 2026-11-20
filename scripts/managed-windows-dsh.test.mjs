import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runManagedWindowsDsh } from './managed-windows-dsh.mjs';

test('starts the owned DSH before the desktop and closes it when the desktop exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yogurt-managed-'));
  const cli = join(dir, 'fixture.cjs');
  const pidFile = join(dir, 'pid');
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  try {
    await writeFile(cli, `
      require('node:assert/strict').deepEqual(process.argv.slice(2), ['--profile', 'meeting', '--no-open', '--port', '${port}']);
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      require('node:http').createServer((req, res) => {
        if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401); return res.end(); }
        res.end(JSON.stringify({ ok: true, plugin: 'dsh-meeting-host', desktopScheduler: true }));
      }).listen(${port}, '127.0.0.1', () => console.log('http://127.0.0.1:${port}/?token=fixture-token'));
    `);
    const code = await runManagedWindowsDsh({ node: process.execPath, cli, port, cwd: dir, env: process.env, launchDesktop: url => {
      assert.equal(url, `http://127.0.0.1:${port}/?token=fixture-token`);
      return spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
    } });
    assert.equal(code, 0);
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

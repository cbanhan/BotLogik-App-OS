import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAppUpdates } from '../src/main/app-updates.js';

function fixture(enabled = true) {
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.0.1' });
  const updater = new EventEmitter();
  const calls = { quit: 0, install: 0, download: 0, check: 0 };
  const prompts = [];
  let active = false;
  let response = 1;
  app.quit = () => calls.quit++;
  updater.quitAndInstall = () => calls.install++;
  updater.checkForUpdates = async () => { calls.check++; return { isUpdateAvailable: true, updateInfo: { version: '1.0.2' } }; };
  updater.downloadUpdate = async () => { calls.download++; updater.emit('update-downloaded'); };
  const dialog = { showMessageBox: async options => { prompts.push(options); return { response }; } };
  const updates = createAppUpdates({ app, updater, dialog, enabled, hasActiveSessions: () => active });
  return { app, updater, updates, calls, prompts, dialog,
    setActive: value => { active = value; }, setResponse: value => { response = value; } };
}

test('downloading requires consent and never installs on ordinary quit', async () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  f.setResponse(0);
  await f.updates.check();
  assert.equal(f.calls.download, 0);
  assert.deepEqual(f.prompts.at(-1).buttons, ['Cancel', 'Update and Restart']);
  assert.equal(f.prompts.at(-1).message, 'A new version is available.');
  f.app.emit('will-quit', { preventDefault() { assert.fail('ordinary quit must proceed'); } });
  assert.equal(f.calls.install, 0);
});

test('one consent downloads and proceeds to restart without another prompt', async () => {
  const f = fixture();
  f.setResponse(1);
  await f.updates.check();
  assert.equal(f.calls.download, 1);
  assert.equal(f.calls.quit, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.calls.install, 0);
  f.app.emit('will-quit', { preventDefault() {} });
  assert.equal(f.calls.install, 1);
});

test('sessions started during download block restart; version check retries without downloading again', async () => {
  const f = fixture();
  f.updater.downloadUpdate = async () => {
    f.calls.download++;
    f.setActive(true);
    f.updater.emit('update-downloaded');
  };
  await f.updates.check();
  assert.equal(f.calls.quit, 0);
  assert.match(f.prompts.at(-1).detail, /click the version number/);
  f.app.emit('will-quit', { preventDefault() { assert.fail('ordinary quit must proceed'); } });
  assert.equal(f.calls.install, 0);
  f.setActive(false);
  await f.updates.check();
  assert.equal(f.calls.check, 1);
  assert.equal(f.calls.download, 1);
  assert.equal(f.calls.quit, 1);
});

test('a failed download does not restart and can be retried', async () => {
  const f = fixture();
  f.updater.downloadUpdate = async () => { throw new Error('download interrupted'); };
  await f.updates.check();
  assert.equal(f.calls.quit, 0);
  assert.match(f.prompts.at(-1).detail, /download interrupted/);
  f.updater.downloadUpdate = async () => f.updater.emit('update-downloaded');
  await f.updates.check();
  assert.equal(f.calls.quit, 1);
});

test('concurrent checks cannot start a second download', async () => {
  const f = fixture();
  let finishDownload;
  f.updater.downloadUpdate = () => new Promise(resolve => { finishDownload = resolve; });
  const firstCheck = f.updates.check();
  await new Promise(resolve => setImmediate(resolve));
  await f.updates.check();
  assert.equal(f.calls.check, 1);
  assert.equal(f.calls.quit, 0);
  f.updater.emit('update-downloaded');
  finishDownload();
  await firstCheck;
  assert.equal(f.calls.quit, 1);
});

test('open sessions block restart, including a session started during confirmation', async () => {
  const f = fixture();
  f.updater.emit('update-downloaded');
  f.setActive(true);
  await f.updates.install();
  assert.equal(f.calls.quit, 0);
  f.setActive(false);
  f.dialog.showMessageBox = async () => { f.setActive(true); return { response: 1 }; };
  await f.updates.install();
  assert.equal(f.calls.quit, 0);
});

test('installer waits for normal quit to pass unsaved-file guards; cancellation allows retry', async () => {
  const f = fixture();
  f.updater.emit('update-downloaded');
  await f.updates.install();
  assert.equal(f.calls.quit, 1);
  assert.equal(f.calls.install, 0);
  assert.equal(f.updates.installing, true);
  f.updates.cancelInstall();
  assert.equal(f.updates.installing, false);
  await f.updates.install();
  let prevented = false;
  f.app.emit('will-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.calls.install, 1);
  f.app.emit('will-quit', { preventDefault() { assert.fail('must not loop'); } });
  assert.equal(f.calls.install, 1);
});

test('failed checks recover and development builds never contact the update feed', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error('offline'); };
  await f.updates.check();
  assert.match(f.prompts.at(-1).message, /Could not update/);
  assert.match(f.prompts.at(-1).detail, /offline/);
  f.updater.checkForUpdates = async () => ({ isUpdateAvailable: false });
  await f.updates.check();
  assert.equal(f.prompts.at(-1).message, 'You are on the latest version.');
  f.app.isPackaged = false;
  f.updater.checkForUpdates = async () => assert.fail('no check in development');
  await f.updates.check({ silent: true });
});

// A packaged community build must never reach any update provider.
test('community builds never check or download updates, including silent startup', async () => {
  const f = fixture(false);
  await f.updates.check({ silent: true });
  assert.equal(f.prompts.length, 0);
  await f.updates.check();
  assert.equal(f.calls.check, 0);
  assert.equal(f.calls.download, 0);
  assert.equal(f.calls.quit, 0);
  assert.equal(f.prompts.at(-1).message, 'Updates are disabled for this build.');
});

// Dependencies are injected so restart safety can be tested without quitting Electron.
export function createAppUpdates({ app, updater, dialog, hasActiveSessions, enabled = false, onState = () => {} }) {
  let busy = false;
  let downloaded = false;
  let installing = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  const state = () => onState({ busy, downloaded, installing });
  const message = (text, detail = '') => dialog.showMessageBox({
    type: 'info', title: 'BotLogik Updates', message: text, detail, buttons: ['OK']
  });

  // checkForUpdates/downloadUpdate also reject; handle the error there once.
  updater.on('error', error => console.warn('BotLogik update failed:', error.message));
  updater.on('update-downloaded', () => { downloaded = true; state(); });

  app.on('will-quit', event => {
    if (!installing) return;
    // Normal app.quit() has now passed all renderer beforeunload confirmations.
    event.preventDefault();
    installing = false;
    updater.quitAndInstall();
  });

  async function restart() {
    if (!downloaded || installing) return;
    if (hasActiveSessions()) {
      await message('Stop your agent sessions before updating.',
        'The update is downloaded. Use Refresh to stop open terminals, and stop scheduled runs. Save your edits, then click the version number to restart and update.');
      return;
    }
    installing = true;
    state();
    app.quit();
  }

  async function install() {
    if (!downloaded || installing) return;
    const { response } = await dialog.showMessageBox({
      type: 'question', title: 'BotLogik Updates', message: 'Restart BotLogik to install the update?',
      detail: 'Save your work first. Unsaved files will still prompt before the app closes.',
      buttons: ['Later', 'Update and Restart'], defaultId: 1, cancelId: 0
    });
    if (response !== 1) return;
    await restart();
  }

  async function check({ silent = false } = {}) {
    if (!enabled) {
      if (!silent) await message('Updates are disabled for this build.', 'Community builds are updated by rebuilding from source.');
      return;
    }
    if (busy || installing) {
      if (!silent) await message('An update is already in progress.', 'Please wait for the current check or download to finish.');
      return;
    }
    if (!app.isPackaged) { if (!silent) await message('Updates are available in the installed app.'); return; }
    if (downloaded) { if (!silent) await install(); return; }
    busy = true;
    state();
    try {
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        if (!silent) await message('You are on the latest version.', `BotLogik ${app.getVersion()}`);
        return;
      }
      const { response } = await dialog.showMessageBox({
        type: 'info', title: 'BotLogik Updates', message: 'A new version is available.',
        detail: `BotLogik ${result.updateInfo.version}. Download and install the update, then reopen BotLogik automatically. Save your work and stop agent sessions first. Unsaved files will still prompt before the app closes.`,
        buttons: ['Cancel', 'Update and Restart'], defaultId: 1, cancelId: 0
      });
      if (response !== 1) return;
      await updater.downloadUpdate();
      await restart();
    } catch (error) {
      const reason = String(error?.message || error || 'Unknown update error').slice(0, 2000);
      if (!silent) await message('Could not update BotLogik.',
        `The update check or download failed. Please share the details below so the problem can be diagnosed.\n\n${reason}`);
      console.warn('BotLogik update check/download:', reason);
    } finally { busy = false; state(); }
  }

  return {
    check, install,
    get installing() { return installing; },
    cancelInstall() { installing = false; state(); }
  };
}

import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export async function resolveCli(command, env) {
  let permissionDenied = false;
  for (const directory of String(env.PATH || '').split(':').filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) { if (error.code === 'EACCES' || error.code === 'EPERM') permissionDenied = true; }
  }
  if (permissionDenied) throw new Error(`EACCES: BotLogik found ${command} on its PATH but could not execute it. Check executable and directory permissions in Terminal.`);
  throw new Error(`CLI_NOT_FOUND: BotLogik could not find an executable ${command} on its PATH. Check its location with "command -v ${command}" in Terminal. Checked directories: ${env.PATH || '(empty)'}`);
}

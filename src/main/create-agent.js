import { chmod, cp, lstat, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { agentNameError } from '../shared/agent-name.js';

export async function createAgentWorkspace(parentPath, rawName, instructionFile = 'agent.md') {
  if (!['agent.md', 'CLAUDE.md'].includes(instructionFile)) throw new Error('Choose agent.md or CLAUDE.md.');
  const error = agentNameError(rawName);
  if (error) throw new Error(error);
  const name = String(rawName).trim();
  const parent = await realpath(parentPath);
  if (!(await stat(parent)).isDirectory()) throw new Error('Choose a parent folder.');
  const path = join(parent, name);
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await lstat(path);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('A file or link already uses that name. Choose another name.');
    }
    return { status: 'exists', path };
  }
  try {
    await writeFile(join(path, instructionFile), `# ${name}\n\nDescribe this agent’s purpose, tasks, and working preferences here.\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    // Never remove a folder here: another process may already have added work.
    throw new Error(`The folder was created at ${path}, but ${instructionFile} could not be written: ${error.message}`);
  }
  return { status: 'created', path };
}

export async function duplicateAgentWorkspace(sourcePath) {
  const source = await realpath(sourcePath);
  if (!(await stat(source)).isDirectory()) throw new Error('Agent folder is unavailable.');
  const parent = dirname(source);
  const name = basename(source);
  let destination;
  for (let suffix = 1; ; suffix++) {
    destination = join(parent, `${name}-copy${suffix === 1 ? '' : `-${suffix}`}`);
    try { await mkdir(destination); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  try {
    for (const entry of await readdir(source)) {
      await cp(join(source, entry), join(destination, entry), { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true });
    }
    await chmod(destination, (await stat(source)).mode);
  } catch (error) {
    throw new Error(`Copy incomplete at ${destination}: ${error.message}`);
  }
  return { status: 'created', path: destination };
}

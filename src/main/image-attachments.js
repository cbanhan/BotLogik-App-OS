import { open, mkdir, realpath, lstat, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES = 10;

export function imagePrompt(provider, paths) {
  if (!['claude', 'codex'].includes(provider)) throw new Error('Start Claude or Codex first.');
  if (!paths.length || paths.length > MAX_IMAGES) throw new Error('Choose 1–10 images.');
  if (paths.some(path => typeof path !== 'string' || /[\x00-\x1f\x7f]/.test(path))) throw new Error('Invalid image path.');
  const instruction = provider === 'codex' ? 'Use view_image to inspect these local images' : 'Read these local images';
  return ` ${instruction}: ${paths.map(path => JSON.stringify(path)).join(', ')}. `;
}

export async function stageImage(root, source, nativeImage) {
  const bytes = await imageBytes(source);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('Unsupported image. Use PNG, JPEG, or WebP.');
  const size = image.getSize();
  if (size.width * size.height > 40000000) throw new Error('Image is too large. Resize it below 40 megapixels.');
  const png = image.toPNG();
  if (png.length > MAX_IMAGE_BYTES) throw new Error('Image is too large after conversion. Resize it below 20 MB.');
  let directory = await realpath(root);
  for (const part of ['.botlogik', 'attachments']) {
    directory = join(directory, part);
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Attachment folder cannot be a symbolic link.');
  }
  const id = randomUUID();
  const path = join(directory, `${id}.png`);
  await writeFile(path, png, { flag: 'wx', mode: 0o600 });
  return { id, path, name: basename(source.name || source.path || 'Screenshot.png'), thumbnail: image.resize({ width: 120, height: 90, quality: 'good' }).toDataURL() };
}

export async function imageBytes(source) {
  let bytes;
  if (source.path) {
    const file = await open(source.path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('Choose an image file up to 20 MB.');
      bytes = Buffer.alloc(info.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
  } else {
    if (!(source.bytes instanceof Uint8Array) || source.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Choose an image up to 20 MB.');
    bytes = Buffer.from(source.bytes);
  }
  return bytes;
}

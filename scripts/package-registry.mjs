#!/usr/bin/env node
/**
 * Assemble the plugin-registry installable root (`registry/`) from the
 * plugin files.
 *
 *   node scripts/package-registry.mjs
 *   dsh registry install ./registry
 *   dsh registry enable theheartfickle/dsh-session-manager
 *
 * The staging directory contains exactly the files the manifest references
 * plus the bundled docs. It is gitignored and rebuilt from scratch on every
 * run.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const out = join(root, 'registry');

/** Files copied into registry/, preserving relative paths. */
const files = [
  'dsh.plugin.json',
  'lib',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const file of files) {
  const source = join(root, file);
  if (!existsSync(source)) {
    console.error(`missing ${file}`);
    process.exit(1);
  }
  const target = join(out, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

console.log(`registry/ assembled (${files.length} files)`);
console.log('next: dsh registry install ./registry && dsh registry enable theheartfickle/dsh-session-manager');

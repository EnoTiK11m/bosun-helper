'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./project-tools');
const MARKER = '# Bosun Helper publication guard v1';
function install(root) {
  const gitDir = fs.realpathSync(path.resolve(root, git(root, ['rev-parse', '--absolute-git-dir']).trim()));
  const hookDir = path.resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']).trim());
  let ancestor = hookDir;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, hookDir));
  if (!(resolved.startsWith(gitDir + path.sep) || resolved.startsWith(fs.realpathSync(root) + path.sep))) {
    throw new Error('Shared/external hooks directory; installation refused. Configure a repository-local hooks directory first.');
  }
  fs.mkdirSync(hookDir, { recursive: true });
  // Проверяем оба хука до записи любого из них. Сохраняем исходные байты и права доступа.
  const plans = ['pre-commit', 'commit-msg', 'pre-push'].map(name => {
    const file = path.join(hookDir, name), old = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlink hook requires manual integration.');
    if (old?.toString('utf8').includes(MARKER)) return null;
    const backup = `${file}.bosun-original`;
    if (fs.existsSync(backup)) throw new Error('Existing hook backup; refusing overwrite.');
    return { name, file, old, backup, mode: old ? fs.statSync(file).mode : 0o755 };
  });
  const touched = [];
  try { for (const plan of plans.filter(Boolean)) {
    if (plan.old) { fs.writeFileSync(plan.backup, plan.old, { flag: 'wx', mode: plan.mode }); plan.backedUp = true; }
    touched.push(plan);
    const script = `#!/bin/sh\n${MARKER}\nset -eu\nroot=$(git rev-parse --show-toplevel) || exit 1\ngit_exec=$(git --exec-path) || exit 1\ncase "$git_exec" in\n  [A-Za-z]:*) git_bin=$("$git_exec/../../../usr/bin/cygpath.exe" -au "$git_exec/../../../usr/bin") || exit 1; PATH="$PATH:$git_bin"; export PATH ;;\nesac\noriginal="$0.bosun-original"\n` +
      (plan.name === 'pre-push'
        ? 'input=$(mktemp) || exit 1\ntrap \'rm -f "$input"\' EXIT HUP INT TERM\ncat > "$input"\nnode "$root/scripts/publication-guard.js" pre-push < "$input" || exit $?\nif [ -x "$original" ]; then "$original" "$@" < "$input"; fi\n'
        : `node "$root/scripts/publication-guard.js" ${plan.name}${plan.name === 'commit-msg' ? ' "$1"' : ''} || exit $?\nif [ -x "$original" ]; then "$original" "$@"; fi\n`);
    fs.writeFileSync(plan.file, script, { mode: 0o755 }); fs.chmodSync(plan.file, 0o755);
  } } catch (error) {
    for (const plan of touched.reverse()) {
      if (plan.old) { fs.writeFileSync(plan.file, plan.old); fs.chmodSync(plan.file, plan.mode); }
      else if (fs.existsSync(plan.file)) fs.unlinkSync(plan.file);
      if (plan.backedUp) fs.unlinkSync(plan.backup);
    }
    throw error;
  }
  return plans.filter(Boolean).length;
}
if (require.main === module) {
  try { const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim(); console.log(`Git hooks installed: ${install(root)} (existing hooks preserved).`); }
  catch (_) { console.error('Hook installation failed: shared/symlink directory or existing backup; no backup overwritten.'); process.exitCode = 1; }
}
module.exports = { install };

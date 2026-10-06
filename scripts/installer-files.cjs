const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async function afterPack(context) {
  const files = [], directories = [];
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) { directories.push(name); await walk(path.join(directory, entry.name), name); }
      else files.push(name);
    }
  }
  await walk(context.appOutDir);
  const quote = name => name.replaceAll('/', '\\').replaceAll('$', '$$').replaceAll('"', '$\\"');
  const lines = ['; Generated from this version of the packaged application. User files are never enumerated.', '!macro removePackagedFiles'];
  for (const name of files) lines.push(`  !insertmacro removeProgramFile "${quote(name)}"`);
  for (const name of directories.sort((a, b) => b.length - a.length)) lines.push(`  RMDir "$INSTDIR\\${quote(name)}"`);
  lines.push('!macroend', '');
  const destination = path.join(context.packager.projectDir, 'build', 'runtime-files.nsh');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, '\uFEFF' + lines.join('\n'));
};

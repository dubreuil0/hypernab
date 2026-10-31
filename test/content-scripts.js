// Runs the extension's content scripts in a test context the way the manifest lists them: texts, design system, panel styles, then the
// content script itself. (Not a test file: it has no tests.)
import fs from 'node:fs';
import vm from 'node:vm';
import { panelCssScript } from '../scripts/build-extensions.js';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
export function runContentScripts(context) {
  if (context.globalThis === null || context.globalThis === undefined) context.globalThis = context; // the scripts reach for globalThis
  vm.runInContext(read('../public/strings.js'), context);
  vm.runInContext(read('../public/ds.js'), context);
  vm.runInContext(panelCssScript(), context);
  return vm.runInContext(read('../extension/content.js'), context);
}

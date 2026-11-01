const fs = require('node:fs');
const path = require('node:path');
const { t } = require('./texts.cjs');

// The renderer supplies ONLY an opaque job id. Paths come from the authenticated engine, not IPC arguments.
async function openJobLocation(id, { lookup, shell }) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error(t('desk.err.jobId'));
  const location = await lookup(id);
  if (!location || typeof location.directory !== 'string' || !path.isAbsolute(location.directory)) throw new Error(t('desk.err.jobLocation'));
  const directory = path.resolve(location.directory);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error(t('desk.err.folderGone'));
  const name = location.file;
  if (name !== null && name !== undefined) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/:\x00-\x1f]/.test(name) || path.basename(name) !== name) throw new Error(t('desk.err.fileLocation'));
    const file = path.join(directory, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) { shell.showItemInFolder(file); return true; }
  }
  const error = await shell.openPath(directory);
  if (error) throw new Error(t('desk.err.folderOpen'));
  return true;
}
// Never execute an arbitrary downloaded program, shortcut, URL or partial file.
async function playJob(id, { lookup, shell }) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error(t('desk.err.jobId'));
  const location = await lookup(id);
  const name = location?.file, directory = location?.directory;
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof name !== 'string' || !name || /[\\/:\x00-\x1f]/.test(name) || path.basename(name) !== name) throw new Error(t('desk.err.noMedia'));
  const media = /\.(?:mp4|mkv|webm|mov|avi|m4v|mpeg|mpg|ts|m2ts|flv|wmv|mp3|m4a|aac|ogg|oga|opus|wav|flac|wma)$/i;
  if (!media.test(name)) throw new Error(t('desk.err.playOnly'));
  const file = path.join(directory, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(t('desk.err.moved'));
  if (!media.test(fs.realpathSync(file))) throw new Error(t('desk.err.notMedia'));
  const error = await shell.openPath(file);
  if (error) throw new Error(t('desk.err.player'));
  return true;
}
module.exports = { openJobLocation, playJob };

// Test only: loaded into a hub with `node --import` so that saving or protecting its config file
// fails, as it does when the file or its folder belongs to another account.
// FAULT_FS=write: the temporary file for a new token cannot be created.
// FAULT_FS=chmod: the config file's permissions cannot be changed.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const refuse = (code, call, path) => {
  throw Object.assign(new Error(`${code}: simulated failure, ${call} '${path}'`), { code });
};
if (process.env.FAULT_FS === 'chmod') fs.chmodSync = (path) => refuse('EPERM', 'chmod', path);
if (process.env.FAULT_FS === 'write') {
  const write = fs.writeFileSync;
  fs.writeFileSync = (path, ...rest) => (String(path).endsWith('.tmp') ? refuse('EACCES', 'open', path) : write(path, ...rest));
}
syncBuiltinESMExports();

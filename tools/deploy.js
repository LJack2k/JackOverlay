'use strict';

// Rebuilds and replaces the installed copy, then restarts it.
//
//   npm run deploy
//   INSTALL_DIR=D:\Somewhere\Else npm run deploy
//
// The installed exe is what actually runs day to day — including at login — so
// updating it is a separate step from editing the source. This is that step.

const path = require('path');
const fs   = require('fs');
const { execFileSync, spawn } = require('child_process');
const { build } = require('./package.js');

const ROOT = path.join(__dirname, '..');
const pkg  = require(path.join(ROOT, 'package.json'));

const INSTALL_DIR = process.env.INSTALL_DIR
  ? path.resolve(process.env.INSTALL_DIR)
  : 'D:\\Apps\\JackOverlay';

const EXE_NAME = `${pkg.productName}.exe`;
const STAGING  = path.join(ROOT, 'build', 'staging');

function log(...a) { console.log(' ', ...a); }

/** The running copy holds its own files open, so it has to go first. */
function stopRunning() {
  try {
    execFileSync('taskkill', ['/IM', EXE_NAME, '/F'], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    });
    log(`stopped ${EXE_NAME}`);
  } catch (_) {
    log(`${EXE_NAME} was not running`);
  }
}

(async () => {
  log(`installing to ${INSTALL_DIR}`);

  stopRunning();
  // Give Windows a moment to release the handles; copying over a just-killed
  // process's files otherwise fails intermittently with EBUSY.
  await new Promise((r) => setTimeout(r, 2500));

  // Staged rather than built straight into place: a failed build should not be
  // able to leave a half-replaced install behind.
  const built = await build(STAGING);

  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.cpSync(built, INSTALL_DIR, { recursive: true, force: true });

  const exe = path.join(INSTALL_DIR, EXE_NAME);
  if (!fs.existsSync(exe)) {
    console.error(`deploy failed: ${exe} is missing`);
    process.exit(1);
  }
  log(`deployed ${EXE_NAME}`);

  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  log('restarted');
  // Settings and log live in %APPDATA%\JackOverlay, so nothing user-owned is
  // touched by replacing the program folder.
  log(`config and log stay in ${path.join(process.env.APPDATA || '', pkg.productName)}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

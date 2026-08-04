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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    }).toString();
    return out.includes(EXE_NAME);
  } catch (_) {
    return false;
  }
}

/**
 * The running copy holds its own files open, so it has to go first — and it has
 * to be *gone*, not merely signalled. A fixed sleep wasn't enough: the copy then
 * failed with a sharing violation because Windows hadn't released the handles.
 */
async function stopRunning() {
  if (!isRunning()) {
    log(`${EXE_NAME} was not running`);
    return;
  }
  try {
    execFileSync('taskkill', ['/IM', EXE_NAME, '/F', '/T'], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    });
  } catch (_) {}

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (!isRunning()) {
      log(`stopped ${EXE_NAME} after ${((i + 1) * 0.5).toFixed(1)}s`);
      await sleep(1000);          // let the file handles drop too
      return;
    }
  }
  throw new Error(`${EXE_NAME} would not exit; nothing was replaced`);
}

/** Windows can still hold a handle briefly after exit, so don't give up at once. */
async function copyWithRetry(from, to, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.cpSync(from, to, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts) throw e;
      log(`copy blocked (${e.code}), retrying ${i}/${attempts - 1}`);
      await sleep(2000);
    }
  }
}

(async () => {
  log(`installing to ${INSTALL_DIR}`);

  // Build first, so a broken build fails before the running app is disturbed.
  // Staged rather than built straight into place: a failed build should not be
  // able to leave a half-replaced install behind.
  const built = await build(STAGING);

  await stopRunning();

  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  await copyWithRetry(built, INSTALL_DIR);

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

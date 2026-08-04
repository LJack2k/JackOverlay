'use strict';

// Builds dist/JackOverlay-win32-x64/JackOverlay.exe
//
//   npm run package
//
// @electron/packager rather than electron-builder: it reuses the Electron zip
// already in the local cache and needs no extra downloads (no NSIS, no signing
// tools). That matters on a machine where GitHub Releases have been unreliable.
// The result is a portable folder rather than an installer.

const path = require('path');
const fs   = require('fs');
// v20 exports named functions rather than a callable module.
const { packager } = require('@electron/packager');

const ROOT = path.join(__dirname, '..');
const pkg  = require(path.join(ROOT, 'package.json'));

// Overridable because Windows occasionally keeps a handle on a previous build's
// app.asar (antivirus or a filter driver — no process shows up holding it), and
// packager can then neither overwrite nor delete it.
const OUT = process.env.PACKAGE_OUT
  ? path.resolve(process.env.PACKAGE_OUT)
  : path.join(ROOT, 'dist');

const ICON = path.join(ROOT, 'build', 'icon.ico');
if (!fs.existsSync(ICON)) {
  console.error(`missing ${ICON} — run "npm run icon" first`);
  process.exit(1);
}

(async () => {
  const paths = await packager({
    dir: ROOT,
    out: OUT,
    name: pkg.productName,
    platform: 'win32',
    arch: 'x64',
    icon: ICON,
    overwrite: true,
    asar: true,
    // No runtime dependencies at all — electron is a devDependency — so this
    // strips node_modules entirely.
    prune: true,
    ignore: [
      /^\/dist($|\/)/,
      /^\/build($|\/)/,
      /^\/tools($|\/)/,
      // The Stream Deck plugin is a separate artefact; it must not be bundled
      // into the app (and it carries its own node_modules).
      /^\/streamdeck($|\/)/,
      /^\/webcam-overlay($|\/)/,      // stray empty folder
      /^\/\.git($|\/)/,
      /^\/\.gitignore$/,
      /^\/README\.md$/,
      // Per-machine state must never ship inside the package.
      /^\/config\.json/,
      /\.log(\.old)?$/,
      /^\/install\.bat$/,
      /^\/start\.bat$/
    ],
    win32metadata: {
      CompanyName: pkg.author,
      FileDescription: pkg.description,
      ProductName: pkg.productName,
      OriginalFilename: `${pkg.productName}.exe`
    }
  });

  for (const p of paths) {
    const exe = path.join(p, `${pkg.productName}.exe`);
    console.log(`packaged: ${p}`);
    console.log(`exe:      ${exe}  (${fs.existsSync(exe) ? 'present' : 'MISSING'})`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

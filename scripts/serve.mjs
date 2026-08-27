/**
 * Static file server for web/, so the explorer can be opened by double-clicking
 * serve.cmd instead of remembering a command line.
 *
 * Why this exists at all: explore.html cannot be opened from the filesystem.
 * Browsers refuse ES modules and fetch() over file:// -- the module script never
 * executes, so the page sits on its initial "starting up" message with nothing in
 * the console to explain it. It has to come over HTTP.
 *
 * Node rather than python: `node` is reliably on PATH here, while `python` on
 * PATH is the Windows Store alias and the working interpreter is inside a conda
 * env that `conda activate` cannot reach from this shell.
 *
 *   node scripts/serve.mjs [--port 8765] [--no-open]
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../web', import.meta.url)));
const DEFAULT_PORT = 8765;
const ENTRY = 'explore.html';

// Explicit rather than a library: the only thing that actually matters is that
// .js and .mjs arrive as JavaScript, since a wrong type makes the browser refuse
// the module and the failure looks identical to the file:// one.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const wantPort = portArg >= 0 ? Number(args[portArg + 1]) : DEFAULT_PORT;
const shouldOpen = !args.includes('--no-open');

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'bad request');
  }
  if (pathname.endsWith('/')) pathname += ENTRY;

  // Contain everything under web/: normalise, then confirm the resolved path is
  // still inside the root before opening anything.
  const target = resolve(join(ROOT, normalize(pathname)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return send(res, 403, 'forbidden');
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(302, { location: `${pathname.replace(/\/?$/, '/')}${ENTRY}` });
      return res.end();
    }
    // `no-cache` means "revalidate before reuse", and revalidating needs
    // something to revalidate *against*. With no validator the browser had no
    // choice but to download in full every time -- which made the deck's
    // `<link rel="prefetch">` hand-off actively worse than nothing, pulling the
    // next site's five megabytes down twice. The validator is size and mtime, so
    // a re-export still invalidates it and the note below still holds.
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const lastModified = info.mtime.toUTCString();
    const since = Date.parse(req.headers['if-modified-since'] || '');
    const fresh = req.headers['if-none-match'] === etag
      // HTTP dates have one-second resolution, so compare against a truncated
      // mtime or a file saved mid-second looks newer than its own timestamp.
      || (!Number.isNaN(since) && since >= Math.floor(info.mtimeMs / 1000) * 1000);
    if (fresh) {
      res.writeHead(304, { etag, 'last-modified': lastModified, 'cache-control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
      // The atlas is megabytes and gets re-fetched on every reload otherwise,
      // but a stale asset after a re-export is worse than a slow reload.
      'cache-control': 'no-cache',
      etag,
      'last-modified': lastModified,
    });
    createReadStream(target).pipe(res);
  } catch {
    send(res, 404, `not found: ${pathname}`);
  }
});

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* opening is a convenience; the URL is printed regardless */
  }
}

// If something is already on the port -- often a server from an earlier session
// serving this very directory -- step up rather than dying with EADDRINUSE.
let port = wantPort;
let attempts = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && attempts < 12) {
    attempts += 1;
    console.log(`  port ${port} is busy, trying ${port + 1}`);
    port += 1;
    server.listen(port);
    return;
  }
  console.error(`\ncould not start: ${err.message}`);
  process.exit(1);
});

server.listen(port, () => {
  const url = `http://localhost:${port}/${ENTRY}`;
  console.log(`\n  serving ${ROOT}`);
  console.log(`  ${url}`);
  console.log('\n  press Ctrl+C to stop\n');
  if (shouldOpen) openBrowser(url);
});

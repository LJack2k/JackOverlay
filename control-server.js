'use strict';

// Loopback control channel for external controllers (the Stream Deck plugin).
//
// Newline-delimited JSON over plain TCP. Both ends are Node, so this needs no
// dependencies at all — which matters on a machine where downloads have been
// unreliable. Bound to 127.0.0.1 only; this must never listen on the network.
//
//   in : { "cmd": "toggleMaximize" }              (one JSON object per line)
//   out: { "event": "state", "mode": "windowed", "visible": true, ... }

const net = require('net');

const MAX_LINE = 64 * 1024;   // a client that never sends \n can't grow the buffer forever

function startControlServer({ port, host = '127.0.0.1', onCommand, getState, log = () => {} }) {
  const clients = new Set();

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sock.setNoDelay(true);
    clients.add(sock);
    log(`control: client connected (${clients.size} connected)`);

    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE) { buf = ''; return; }

      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;

        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }   // ignore junk
        try { onCommand(msg, sock); }
        catch (e) { log(`control: command failed: ${e.message}`); }
      }
    });

    const drop = () => {
      if (clients.delete(sock)) log(`control: client gone (${clients.size} connected)`);
    };
    sock.on('close', drop);
    sock.on('error', drop);

    // Greet with current state so a controller renders correctly the moment it
    // attaches, without having to ask.
    send(sock, { event: 'state', ...getState() });
  });

  server.on('error', (e) => {
    // EADDRINUSE usually means a second copy of the overlay is already running.
    log(`control: server error: ${e.message}`);
  });

  server.listen(port, host, () => log(`control: listening on ${host}:${port}`));

  function send(sock, obj) {
    try { sock.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  function broadcast(obj) {
    for (const s of clients) send(s, obj);
  }

  function close() {
    for (const s of clients) { try { s.destroy(); } catch (_) {} }
    clients.clear();
    try { server.close(); } catch (_) {}
  }

  return { broadcast, close };
}

module.exports = { startControlServer };

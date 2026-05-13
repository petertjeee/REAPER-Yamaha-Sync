const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'REAPER ↔ Yamaha Channel Sync',
    backgroundColor: '#1a1a2e'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Network interfaces ───────────────────────────────────────────────────────
ipcMain.handle('get-network-interfaces', () => {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({ name, address: addr.address, netmask: addr.netmask, cidr: addr.cidr });
      }
    }
  }
  return result;
});

// ─── Yamaha RCP ───────────────────────────────────────────────────────────────
// Active TCP connections keyed by id
const rcpConnections = new Map();

ipcMain.handle('rcp-connect', async (event, { id, host, port }) => {
  return new Promise((resolve) => {
    if (rcpConnections.has(id)) {
      rcpConnections.get(id).socket.destroy();
      rcpConnections.delete(id);
    }

    const socket = new net.Socket();
    let buffer = '';
    // FIFO queue: each entry is a { resolve, timer } waiting for the next OK/ERROR line
    const queue = [];
    let connectResolved = false;

    socket.setTimeout(5000);

    socket.on('connect', () => {
      connectResolved = true;
      rcpConnections.set(id, { socket, queue });
      resolve({ ok: true });
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // NOTIFY = unsolicited change from console — forward to renderer, do NOT consume queue
        if (trimmed.startsWith('NOTIFY')) {
          mainWindow?.webContents.send('rcp-notify', { id, line: trimmed });
          continue;
        }

        // Resolve the oldest pending command if this is a response line
        if (trimmed.startsWith('OK') || trimmed.startsWith('OKm') || trimmed.startsWith('ERROR')) {
          if (queue.length > 0) {
            const entry = queue.shift();
            clearTimeout(entry.timer);
            entry.resolve(trimmed);
          }
          mainWindow?.webContents.send('rcp-data', { id, line: trimmed });
        }
      }
    });

    socket.on('timeout', () => {
      if (!connectResolved) {
        socket.destroy();
        resolve({ ok: false, error: 'Connection timed out' });
      }
    });

    socket.on('error', (err) => {
      if (!connectResolved) {
        resolve({ ok: false, error: err.message });
      } else {
        mainWindow?.webContents.send('rcp-error', { id, error: err.message });
      }
    });

    socket.on('close', () => {
      rcpConnections.delete(id);
      mainWindow?.webContents.send('rcp-closed', { id });
    });

    socket.connect(port || 49280, host);
  });
});

ipcMain.handle('rcp-disconnect', (event, { id }) => {
  const conn = rcpConnections.get(id);
  if (conn) {
    conn.socket.destroy();
    rcpConnections.delete(id);
  }
  return { ok: true };
});

// Send one command and wait for the next OK/ERROR response
function rcpSendOne(conn, command, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Remove this entry from queue on timeout
      const idx = conn.queue.findIndex(e => e._timer === timer);
      if (idx !== -1) conn.queue.splice(idx, 1);
      resolve({ ok: false, error: 'Timeout' });
    }, timeoutMs);
    const entry = { resolve: (line) => resolve({ ok: true, response: line }), timer };
    entry._timer = timer;
    conn.queue.push(entry);
    conn.socket.write(command + '\n');
  });
}

ipcMain.handle('rcp-send', async (event, { id, command }) => {
  const conn = rcpConnections.get(id);
  if (!conn) return { ok: false, error: 'Not connected' };
  return rcpSendOne(conn, command, 3000);
});

// Probe actual channel count for a type by finding where ERROR starts
async function probeChannelCount(conn, type, maxHint) {
  // Binary search: find the first index that returns ERROR
  // Start by checking index 0 — if that errors, count is 0
  const r0 = await rcpSendOne(conn, `get MIXER:Current/${type}/Label/Name 0 0`, 2000);
  if (!r0.ok || r0.response.startsWith('ERROR')) return 0;

  let lo = 1, hi = maxHint;
  // Quick check: if hi-1 is OK, the full count is valid
  const rhi = await rcpSendOne(conn, `get MIXER:Current/${type}/Label/Name ${hi - 1} 0`, 2000);
  if (rhi.ok && rhi.response.startsWith('OK')) return hi;

  // Binary search between lo and hi
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await rcpSendOne(conn, `get MIXER:Current/${type}/Label/Name ${mid} 0`, 2000);
    if (r.ok && r.response.startsWith('OK')) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

ipcMain.handle('rcp-probe-counts', async (event, { id, channelTypes }) => {
  const conn = rcpConnections.get(id);
  if (!conn) return { ok: false, error: 'Not connected' };

  const counts = {};
  for (const { type, maxHint } of channelTypes) {
    counts[type] = await probeChannelCount(conn, type, maxHint);
  }
  return { ok: true, counts };
});

ipcMain.handle('rcp-get-channel-names', async (event, { id, channelTypes }) => {
  const conn = rcpConnections.get(id);
  if (!conn) return { ok: false, error: 'Not connected' };

  const results = {};
  // channelTypes: array of { type: 'InCh'|'StInCh'|'Mix', count: N }
  for (const { type, count } of channelTypes) {
    results[type] = [];
    for (let i = 0; i < count; i++) {
      const r = await rcpSendOne(conn, `get MIXER:Current/${type}/Label/Name ${i} 0`, 2000);
      // Stop fetching this type the moment we hit an ERROR (console doesn't have this channel)
      if (!r.ok || r.response.startsWith('ERROR')) {
        mainWindow?.webContents.send('rcp-data', { id, line: `[probe] ${type} actual count: ${i}` });
        break;
      }
      const match = r.response.match(/"([^"]*)"/);
      results[type].push({ index: i, name: match ? match[1] : '' });
    }
  }
  return { ok: true, results };
});

// Fetch channel colors for given types
ipcMain.handle('rcp-get-channel-colors', async (event, { id, channelTypes }) => {
  const conn = rcpConnections.get(id);
  if (!conn) return { ok: false, error: 'Not connected' };

  const COLOR_MAP = { 'Off': null, 'Red': '#e74c3c', 'Yellow': '#f1c40f', 'Green': '#2ecc71',
    'Cyan': '#1abc9c', 'Blue': '#3498db', 'Magenta': '#9b59b6', 'White': '#ecf0f1',
    'Orange': '#e67e22', 'LightBlue': '#74b9ff', 'Purple': '#a29bfe', 'Pink': '#fd79a8' };

  const results = {};
  for (const { type, count } of channelTypes) {
    results[type] = [];
    for (let i = 0; i < count; i++) {
      const r = await rcpSendOne(conn, `get MIXER:Current/${type}/Label/Color ${i} 0`, 1500);
      if (!r.ok || r.response.startsWith('ERROR')) { results[type].push(null); continue; }
      const m = r.response.match(/"([^"]*)"/);
      const key = m ? m[1] : 'White';
      results[type].push(COLOR_MAP[key] || '#ecf0f1');
    }
  }
  return { ok: true, results };
});

ipcMain.handle('rcp-set-channel-name', async (event, { id, type, index, name }) => {
  const conn = rcpConnections.get(id);
  if (!conn) return { ok: false, error: 'Not connected' };

  const safeName = name.replace(/"/g, '').substring(0, 20);
  const cmd = `set MIXER:Current/${type}/Label/Name ${index} 0 "${safeName}"`;
  const r = await rcpSendOne(conn, cmd, 2000);
  return { ok: r.ok && r.response.startsWith('OK'), response: r.response, error: r.error };
});

// ─── REAPER OSC ───────────────────────────────────────────────────────────────
// We act as an OSC controller:
//   - Listen on a UDP port for REAPER feedback (track names sent to us)
//   - Send OSC messages to REAPER to get/set track names

const oscSockets = new Map();

function encodeOSC(address, ...args) {
  // Minimal OSC encoder for string messages
  function padded(str) {
    const buf = Buffer.from(str + '\0');
    const pad = 4 - (buf.length % 4);
    if (pad < 4) return Buffer.concat([buf, Buffer.alloc(pad)]);
    return buf;
  }

  function int32(n) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n, 0);
    return b;
  }

  const addrBuf = padded(address);

  // Build type tag
  let typeTags = ',';
  const valueBufs = [];
  for (const arg of args) {
    if (typeof arg === 'string') {
      typeTags += 's';
      valueBufs.push(padded(arg));
    } else if (typeof arg === 'number') {
      if (Number.isInteger(arg)) {
        typeTags += 'i';
        valueBufs.push(int32(arg));
      } else {
        typeTags += 'f';
        const b = Buffer.alloc(4);
        b.writeFloatBE(arg, 0);
        valueBufs.push(b);
      }
    }
  }

  const tagBuf = padded(typeTags);
  return Buffer.concat([addrBuf, tagBuf, ...valueBufs]);
}

function decodeOSCString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.slice(offset, end).toString('utf8');
  const padded = end + 1;
  const nextOffset = padded + ((4 - (padded % 4)) % 4);
  return { value: str, nextOffset };
}

function decodeOSCMessage(buf) {
  try {
    const addr = decodeOSCString(buf, 0);
    const types = decodeOSCString(buf, addr.nextOffset);
    let offset = types.nextOffset;
    const args = [];
    for (const t of types.value.replace(',', '')) {
      if (t === 's') {
        const s = decodeOSCString(buf, offset);
        args.push(s.value);
        offset = s.nextOffset;
      } else if (t === 'i') {
        args.push(buf.readInt32BE(offset));
        offset += 4;
      } else if (t === 'f') {
        args.push(buf.readFloatBE(offset));
        offset += 4;
      }
    }
    return [{ address: addr.value, args }];
  } catch {
    return null;
  }
}

function decodeOSCBundle(buf) {
  try {
    // Bundle starts with '#bundle\0' (8 bytes) + timetag (8 bytes)
    const header = buf.slice(0, 8).toString('utf8').replace(/\0/g, '');
    if (header !== '#bundle') return null;
    let offset = 16; // skip '#bundle\0' + timetag
    const messages = [];
    while (offset < buf.length) {
      const size = buf.readInt32BE(offset);
      offset += 4;
      const element = buf.slice(offset, offset + size);
      offset += size;
      // Recursively handle nested bundles or individual messages
      const nested = decodeOSCPacket(element);
      if (nested) messages.push(...nested);
    }
    return messages;
  } catch {
    return null;
  }
}

function decodeOSCPacket(buf) {
  if (buf.length === 0) return null;
  if (buf[0] === 0x23) return decodeOSCBundle(buf); // '#'
  return decodeOSCMessage(buf);
}

ipcMain.handle('osc-start', (event, { id, listenPort }) => {
  if (oscSockets.has(id)) {
    oscSockets.get(id).close();
    oscSockets.delete(id);
  }

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, rinfo) => {
    const messages = decodeOSCPacket(msg);
    if (messages) {
      for (const decoded of messages) {
        if (/^\/track\/\d+\/(name|number\/str)$/.test(decoded.address)) {
          require('fs').appendFileSync(require('path').join(__dirname, 'osc-debug.log'), `${decoded.address} = ${JSON.stringify(decoded.args)}\n`);
        }
        mainWindow?.webContents.send('osc-message', { id, ...decoded, from: rinfo.address });
      }
    }
  });

  sock.on('error', (err) => {
    mainWindow?.webContents.send('osc-error', { id, error: err.message });
  });

  return new Promise((resolve) => {
    sock.bind(listenPort, () => {
      oscSockets.set(id, sock);
      resolve({ ok: true, port: sock.address().port });
    });
    sock.once('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

ipcMain.handle('osc-stop', (event, { id }) => {
  const sock = oscSockets.get(id);
  if (!sock) return { ok: true };
  return new Promise((resolve) => {
    oscSockets.delete(id);
    sock.close(() => resolve({ ok: true }));
  });
});

ipcMain.handle('osc-send', (event, { id, targetHost, targetPort, address, args }) => {
  const sock = oscSockets.get(id);
  if (!sock) return { ok: false, error: 'OSC socket not open' };

  const msg = encodeOSC(address, ...args);
  return new Promise((resolve) => {
    sock.send(msg, 0, msg.length, targetPort, targetHost, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
});

// ─── mDNS / Network scan for Yamaha autodiscovery ────────────────────────────
ipcMain.handle('scan-hosts', async (event, { subnet, port }) => {
  // Quick TCP connect scan of common Yamaha IPs on the given subnet
  const parts = subnet.split('.');
  if (parts.length < 3) return { ok: false, error: 'Invalid subnet' };
  const base = parts.slice(0, 3).join('.');

  const promises = [];
  for (let i = 1; i <= 254; i++) {
    const host = `${base}.${i}`;
    promises.push(
      new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(300);
        sock.once('connect', () => { sock.destroy(); resolve(host); });
        sock.once('error', () => { sock.destroy(); resolve(null); });
        sock.once('timeout', () => { sock.destroy(); resolve(null); });
        sock.connect(port || 49280, host);
      })
    );
  }

  const results = await Promise.all(promises);
  return { ok: true, hosts: results.filter(Boolean) };
});

// ─── REAPER auto-configure (edit reaper.ini directly, same method as MarkerMatic) ──
function getReaperResourcePath() {
  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'REAPER');
  } else if (platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'REAPER');
  } else {
    return path.join(os.homedir(), '.config', 'REAPER');
  }
}

function parseReaperIni(iniPath) {
  const text = fs.readFileSync(iniPath, 'utf8');
  // Minimal INI parser: sections and key=value pairs
  const sections = {};
  let current = '__root__';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1].toLowerCase();
      if (!sections[current]) sections[current] = { _order: [], _map: {} };
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1 && sections[current]) {
      const key = line.slice(0, eqIdx);
      const val = line.slice(eqIdx + 1);
      sections[current]._order.push(key);
      sections[current]._map[key.toLowerCase()] = { key, val };
    }
  }
  return { sections, raw: text };
}

function writeReaperIni(iniPath, sections, originalRaw) {
  // Backup first
  const bak = iniPath + '.before-reaper-yamaha-sync.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(iniPath, bak);
  fs.copyFileSync(iniPath, iniPath + '.bak');

  // Rebuild file: replace the [reaper] section lines for csurf_cnt and csurf_N,
  // preserving everything else exactly as-is.
  const lines = originalRaw.split(/\r?\n/);
  let inReaperSection = false;
  const rewritten = [];
  const injected = new Set();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      inReaperSection = sectionMatch[1].toLowerCase() === 'reaper';
      rewritten.push(rawLine);
      continue;
    }
    if (inReaperSection) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).toLowerCase();
        const sec = sections['reaper'];
        if (sec && sec._map[key]) {
          rewritten.push(`${sec._map[key].key}=${sec._map[key].val}`);
          injected.add(key);
          continue;
        }
      }
    }
    rewritten.push(rawLine);
  }

  // Append any new keys that weren't in the original file
  const sec = sections['reaper'];
  if (sec) {
    for (const k of Object.keys(sec._map)) {
      if (!injected.has(k)) {
        // Find [reaper] section end and insert there — simpler: just append to file
        rewritten.push(`${sec._map[k].key}=${sec._map[k].val}`);
      }
    }
  }

  fs.writeFileSync(iniPath, rewritten.join('\n'), 'utf8');
}

ipcMain.handle('reaper-auto-configure', (event, { rcvPort, sndPort }) => {
  try {
    const resourcePath = getReaperResourcePath();

    // Patch Default.ReaperOSC: set DEVICE_TRACK_COUNT to 8 (we iterate banks to get all tracks)
    const oscFilePath = path.join(resourcePath, 'OSC', 'Default.ReaperOSC');
    if (fs.existsSync(oscFilePath)) {
      let oscContent = fs.readFileSync(oscFilePath, 'utf8');
      oscContent = oscContent.replace(/^DEVICE_TRACK_COUNT\s+\d+\r?$/m, 'DEVICE_TRACK_COUNT 8');
      oscContent = oscContent.replace(/^DEVICE_TRACK_BANK_FOLLOWS\s+\w+\r?$/m, 'DEVICE_TRACK_BANK_FOLLOWS MIXER');
      fs.writeFileSync(oscFilePath, oscContent, 'utf8');
    }

    const iniPath = path.join(resourcePath, 'reaper.ini');

    if (!fs.existsSync(iniPath)) {
      return { ok: false, error: `reaper.ini not found at: ${iniPath}\n\nIs REAPER installed and has it been run at least once?` };
    }

    const { sections, raw } = parseReaperIni(iniPath);

    if (!sections['reaper']) {
      return { ok: false, error: 'Could not find [reaper] section in reaper.ini' };
    }

    const sec = sections['reaper'];

    const entryVal = `OSC "REAPER-Yamaha Sync" 3 ${sndPort} "127.0.0.1" ${rcvPort} 1024 10 ""`;
    const csurfCnt = parseInt(sec._map['csurf_cnt']?.val || '0');

    // Check if an identical entry already exists — if so, nothing to do
    for (let i = 0; i < csurfCnt; i++) {
      if ((sec._map[`csurf_${i}`]?.val || '') === entryVal) {
        return { ok: true, alreadyExists: true };
      }
    }

    // Replace any existing OSC entry with our entry to avoid duplicates
    let replaced = false;
    for (let i = 0; i < csurfCnt; i++) {
      const entry = sec._map[`csurf_${i}`]?.val || '';
      if (entry.startsWith('OSC')) {
        sec._map[`csurf_${i}`] = { key: `csurf_${i}`, val: entryVal };
        replaced = true;
        break;
      }
    }

    // No existing OSC entry — add a new one
    if (!replaced) {
      sec._map[`csurf_${csurfCnt}`] = { key: `csurf_${csurfCnt}`, val: entryVal };
      sec._map['csurf_cnt'] = { key: 'csurf_cnt', val: String(csurfCnt + 1) };
    }

    writeReaperIni(iniPath, sections, raw);

    return { ok: true, alreadyExists: false, iniPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});


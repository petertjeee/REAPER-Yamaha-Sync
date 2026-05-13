// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  yamahaConnected: false,
  reaperConnected: false,
  syncDirection: 'yamaha-to-reaper',
  scanCancelled: false,
  // Channel data: { type, index, yamahaName, reaperName, trackNum, status, selected, color }
  channels: [],
  // REAPER track names received via OSC, keyed by track number (1-based)
  reaperTracks: {},
  // Channel type → count based on console type
  consoleCounts: {
    QL:  { InCh: 32, StInCh: 8, Mix: 16 },
    DM7: { InCh: 120, StInCh: 8, Mix: 24 },
    CL:  { InCh: 72, StInCh: 8, Mix: 24 }
  }
};

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const logEl = document.getElementById('log');
  const now = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.innerHTML = `<span class="log-time">[${now}]</span>${escapeHtml(msg)}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  // Keep max 300 lines
  while (logEl.children.length > 300) logEl.removeChild(logEl.firstChild);
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadNetworkInterfaces();
  bindEvents();
  updateUI();

  // Restore last-used Yamaha IP
  const lastIp = localStorage.getItem('yamaha-last-ip');
  if (lastIp) {
    const ipEl = document.getElementById('yamaha-ip');
    if (!ipEl.value) ipEl.value = lastIp;
  }

  log('REAPER ↔ Yamaha Sync ready.', 'ok');
  log('Connect to Yamaha console and REAPER to get started.', 'info');
});

async function loadNetworkInterfaces() {
  const ifaces = await window.api.getNetworkInterfaces();
  const sel = document.getElementById('iface-select');
  sel.innerHTML = '';
  if (ifaces.length === 0) {
    sel.innerHTML = '<option value="">No interfaces found</option>';
    return;
  }
  for (const iface of ifaces) {
    const opt = document.createElement('option');
    opt.value = iface.address;
    opt.textContent = `${iface.name} — ${iface.address}`;
    sel.appendChild(opt);
  }
}

// ─── Event bindings ───────────────────────────────────────────────────────────
function bindEvents() {
  // Yamaha connect/disconnect
  document.getElementById('yamaha-connect-btn').addEventListener('click', connectYamaha);
  document.getElementById('yamaha-disconnect-btn').addEventListener('click', disconnectYamaha);

  // REAPER connect/disconnect
  document.getElementById('reaper-connect-btn').addEventListener('click', connectReaper);
  document.getElementById('reaper-disconnect-btn').addEventListener('click', disconnectReaper);

  // Scan
  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('cancel-scan-btn').addEventListener('click', () => { state.scanCancelled = true; });

  // Sync direction
  document.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.syncDirection = btn.dataset.dir;
    });
  });

  // Sync
  document.getElementById('sync-btn').addEventListener('click', doSync);

  // Fetch names
  document.getElementById('fetch-names-btn').addEventListener('click', fetchAllNames);

  // Select all / none toolbar buttons
  document.getElementById('select-all-btn').addEventListener('click', () => setAllSelected(true));
  document.getElementById('select-none-btn').addEventListener('click', () => setAllSelected(false));

  // Header checkbox
  document.getElementById('select-all-hdr').addEventListener('change', (e) => setAllSelected(e.target.checked));

  // Clear table/log
  document.getElementById('clear-table-btn').addEventListener('click', clearTable);
  document.getElementById('clear-log-btn').addEventListener('click', () => {
    document.getElementById('log').innerHTML = '';
  });

  // Tests
  document.getElementById('test-yamaha-btn').addEventListener('click', testYamaha);
  document.getElementById('test-reaper-btn').addEventListener('click', testReaper);

  // REAPER auto-configure
  document.getElementById('reaper-autoconfig-btn').addEventListener('click', reaperAutoConfigure);

  // REAPER help toggle
  document.getElementById('reaper-help-btn').addEventListener('click', () => {
    document.getElementById('reaper-help-box').classList.toggle('hidden');
  });

  // Refresh REAPER track names — fire and forget, names populate live in the table
  document.getElementById('reaper-refresh-btn').addEventListener('click', () => {
    setReaperLoading(true);
    clearTimeout(state._loadingSafetyTimer);
    state._loadingSafetyTimer = setTimeout(() => setReaperLoading(false), 15000);
    requestReaperTrackNames({ clearFirst: true });
  });

  // Keep REAPER hint ports in sync
  document.getElementById('reaper-listen-port').addEventListener('input', updateReaperHints);
  document.getElementById('reaper-send-port').addEventListener('input', updateReaperHints);

  // IPC events from main process
  window.api.on('rcp-data', ({ id, line }) => {
    if (id === 'yamaha') log(`[YMH ←] ${line}`, 'data');
  });

  window.api.on('rcp-error', ({ id, error }) => {
    log(`[YMH ERROR] ${error}`, 'error');
    if (id === 'yamaha') setYamahaConnected(false);
  });

  window.api.on('rcp-closed', ({ id }) => {
    if (id === 'yamaha') {
      log('Yamaha connection closed.', 'warn');
      setYamahaConnected(false);
    }
  });

  window.api.on('rcp-notify', ({ id, line }) => {
    if (id === 'yamaha') handleYamahaNotify(line);
  });

  window.api.on('osc-message', ({ address, args, from }) => {
    handleOscMessage(address, args, from);
  });

  window.api.on('osc-error', ({ id, error }) => {
    log(`[OSC ERROR] ${error}`, 'error');
  });
}

function updateReaperHints() {
  document.getElementById('hint-listen-port').textContent = document.getElementById('reaper-listen-port').value;
  document.getElementById('hint-send-port').textContent = document.getElementById('reaper-send-port').value;
}

// ─── Yamaha connection ────────────────────────────────────────────────────────
async function connectYamaha() {
  const host = document.getElementById('yamaha-ip').value.trim();
  const port = parseInt(document.getElementById('yamaha-port').value) || 49280;

  if (host) localStorage.setItem('yamaha-last-ip', host);

  if (!host) {
    log('Please enter the Yamaha console IP address.', 'error');
    return;
  }

  log(`Connecting to Yamaha console at ${host}:${port}…`, 'info');
  setBtn('yamaha-connect-btn', true);

  const result = await window.api.rcpConnect({ id: 'yamaha', host, port });

  setBtn('yamaha-connect-btn', false);

  if (result.ok) {
    setYamahaConnected(true);
    log(`Connected to Yamaha console at ${host}:${port}`, 'ok');
    document.getElementById('fetch-names-btn').disabled = false;
  } else {
    setYamahaConnected(false);
    log(`Failed to connect: ${result.error}`, 'error');
    showTestResult(`❌ ${result.error}`, 'fail');
  }
}

async function disconnectYamaha() {
  await window.api.rcpDisconnect({ id: 'yamaha' });
  setYamahaConnected(false);
  log('Disconnected from Yamaha console.', 'info');
}

function setYamahaConnected(connected) {
  state.yamahaConnected = connected;
  updateUI();
}

// ─── REAPER connection ────────────────────────────────────────────────────────
async function connectReaper() {
  const listenPort = parseInt(document.getElementById('reaper-listen-port').value) || 9000;
  const host       = document.getElementById('reaper-host').value.trim() || '127.0.0.1';
  const sendPort   = parseInt(document.getElementById('reaper-send-port').value) || 8000;

  const connectBtn = document.getElementById('reaper-connect-btn');
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';

  const result = await window.api.oscStart({ id: 'reaper', listenPort });

  if (!result.ok) {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
    log(`Failed to start OSC listener: ${result.error}`, 'error');
    return;
  }

  connectBtn.textContent = 'Verifying…';
  log(`Verifying REAPER OSC at ${host}:${sendPort}…`, 'info');
  state.reaperPingReceived = false;

  // Step 1: send count to trigger REAPER's push and verify it's alive
  await window.api.oscSend({
    id: 'reaper', targetHost: host, targetPort: sendPort,
    address: '/device/track/count', args: [8]
  });

  // Wait up to 2000ms for any OSC message to arrive
  const deadline = Date.now() + 2000;
  while (!state.reaperPingReceived && Date.now() < deadline) {
    await sleep(80);
  }

  connectBtn.disabled = false;
  connectBtn.textContent = 'Connect';

  if (!state.reaperPingReceived) {
    await window.api.oscStop({ id: 'reaper' });
    log(`No response from REAPER at ${host}:${sendPort}. Is REAPER running with OSC enabled?`, 'error');
    document.getElementById('reaper-help-box').classList.remove('hidden');
    setReaperConnected(false);
    return;
  }

  setReaperConnected(true);
  log(`REAPER OSC connected (${host}).`, 'ok');

  // Step 2: now REAPER is confirmed listening — reset to bank 1 and re-request names
  setReaperLoading(true);
  requestReaperTrackNames({ clearFirst: true });
}

async function disconnectReaper() {
  const disconnectBtn = document.getElementById('reaper-disconnect-btn');
  disconnectBtn.disabled = true;
  disconnectBtn.textContent = 'Disconnecting…';
  await window.api.oscStop({ id: 'reaper' });
  disconnectBtn.textContent = 'Disconnect';
  state.reaperTracks = {};
  state.reaperPingReceived = false;
  setReaperConnected(false);
  log('REAPER OSC disconnected.', 'info');
}

function setReaperConnected(connected) {
  state.reaperConnected = connected;
  updateUI();
}

function setReaperLoading(loading) {
  const refreshBtn = document.getElementById('reaper-refresh-btn');
  refreshBtn.textContent = loading ? '⏳' : '↺';
  refreshBtn.disabled = loading;
  document.getElementById('reaper-connect-btn').disabled = loading || state.reaperConnected;
  document.getElementById('reaper-disconnect-btn').disabled = loading || !state.reaperConnected;
}

// ─── Yamaha NOTIFY handling ───────────────────────────────────────────────────
function handleYamahaNotify(line) {
  // Format: NOTIFY get MIXER:Current/{type}/Label/Name {ch} 0 "NewName"
  const nameMatch = line.match(/^NOTIFY\s+(?:get|set)\s+MIXER:Current\/(\w+)\/Label\/Name\s+(\d+)\s+\d+\s+"([^"]*)"/);
  if (nameMatch) {
    const [, type, chStr, newName] = nameMatch;
    const chIndex = parseInt(chStr);
    const ch = state.channels.find(c => c.type === type && c.index === chIndex);
    if (ch) {
      ch.yamahaName = newName;
      log(`[DBG] Yamaha NOTIFY: ${type} ch${chIndex + 1} → "${newName}"`, 'info');
      renderTable();
    }
    return;
  }
}

// ─── OSC message handling ─────────────────────────────────────────────────────
function handleOscMessage(address, args, from) {
  // REAPER sends /track/N/name THEN /track/N/number/str for each slot.
  // Buffer the name, then when number/str arrives, store with correct absolute number.

  const nameMatch = address.match(/^\/track\/(\d+)\/name$/);
  if (nameMatch) {
    const slot = parseInt(nameMatch[1]);
    if (!state._reaperNameBuffer) state._reaperNameBuffer = {};
    state._reaperNameBuffer[slot] = args[0] || '';

    // Debounce only the loading spinner — fires after the burst + custom names settle
    clearTimeout(state._tableUpdateTimer);
    state._tableUpdateTimer = setTimeout(() => {
      clearTimeout(state._loadingSafetyTimer);
      setReaperLoading(false);
    }, 1500);

    // Flag for connect ping detection
    state.reaperPingReceived = true;
    if (!state.reaperConnected) setReaperConnected(true);
    return;
  }

  const numMatch = address.match(/^\/track\/(\d+)\/number\/str$/);
  if (numMatch) {
    const slot = parseInt(numMatch[1]);
    const trackNum = parseInt(args[0]);
    if (isNaN(trackNum)) return;

    // Pair with the buffered name for this slot
    const name = (state._reaperNameBuffer && state._reaperNameBuffer[slot]) || '';
    const isDefault = !name || name.trim().toLowerCase() === `track ${trackNum}`;
    if (!isDefault) {
      state.reaperTracks[trackNum] = name;
      log(`[DBG] Track ${trackNum} stored: "${name}"`, 'info');
      updateReaperNamesInTable();
    } else {
      delete state.reaperTracks[trackNum];
    }
    return;
  }

  // Flag used by the connect round-trip check
  state.reaperPingReceived = true;
  if (!state.reaperConnected) setReaperConnected(true);
}

async function requestReaperTrackNames({ clearFirst = false } = {}) {
  if (!state.reaperConnected) return;

  const host     = document.getElementById('reaper-host').value.trim() || '127.0.0.1';
  const sendPort = parseInt(document.getElementById('reaper-send-port').value) || 8000;

  if (clearFirst) {
    state.reaperTracks = {};
    updateReaperNamesInTable();
  }

  // REAPER uses 8-track banks. Navigate to bank 1 first, then iterate forward.
  // Absolute track numbers come from /track/N/number/str — no timing issues.
  state._reaperSlotMap = {};

  // Navigate to bank 1
  for (let i = 0; i < 32; i++) {
    await window.api.oscSend({
      id: 'reaper', targetHost: host, targetPort: sendPort,
      address: '/device/track/bank/-', args: []
    });
    await sleep(30);
  }
  await sleep(500);

  // Iterate forward through all 32 banks
  for (let bank = 0; bank < 32; bank++) {
    await window.api.oscSend({
      id: 'reaper', targetHost: host, targetPort: sendPort,
      address: '/device/track/count', args: [8]
    });
    await sleep(200);
    if (bank < 31) {
      await window.api.oscSend({
        id: 'reaper', targetHost: host, targetPort: sendPort,
        address: '/device/track/bank/+', args: []
      });
      await sleep(50);
    }
  }

  // If no track names arrived (e.g. empty project), clear the loading state now
  clearTimeout(state._tableUpdateTimer);
  state._tableUpdateTimer = setTimeout(() => {
    clearTimeout(state._loadingSafetyTimer);
    setReaperLoading(false);
  }, 1500);
}

function getConsoleChannelCount() {
  const type = document.getElementById('console-type').value;
  const counts = state.consoleCounts[type] || state.consoleCounts.DM7;
  let total = 0;
  if (document.getElementById('sync-inch').checked)   total += counts.InCh;
  if (document.getElementById('sync-stinch').checked) total += counts.StInCh;
  if (document.getElementById('sync-mix').checked)    total += counts.Mix;
  return Math.max(total, counts.InCh);
}

// ─── Fetch channel names from Yamaha ───────────────────────────────────────────────
async function fetchAllNames() {
  if (!state.yamahaConnected) {
    log('Not connected to Yamaha console.', 'error');
    return;
  }

  const consoleType = document.getElementById('console-type').value;
  const hints = state.consoleCounts[consoleType] || state.consoleCounts.DM7;

  const typesToProbe = [];
  if (document.getElementById('sync-inch').checked)   typesToProbe.push({ type: 'InCh',   maxHint: hints.InCh });
  if (document.getElementById('sync-stinch').checked) typesToProbe.push({ type: 'StInCh', maxHint: hints.StInCh });
  if (document.getElementById('sync-mix').checked)    typesToProbe.push({ type: 'Mix',    maxHint: hints.Mix });

  if (typesToProbe.length === 0) {
    log('No channel types selected.', 'warn');
    return;
  }

  setBtn('fetch-names-btn', true);

  // Step 1: probe actual counts
  log(`Probing channel counts (${typesToProbe.map(t => t.type).join(', ')})…`, 'info');
  const probeResult = await window.api.rcpProbeCounts({ id: 'yamaha', channelTypes: typesToProbe });

  if (!probeResult.ok) {
    log(`Probe failed: ${probeResult.error}`, 'error');
    setBtn('fetch-names-btn', false);
    return;
  }

  const channelTypes = typesToProbe
    .map(({ type }) => ({ type, count: probeResult.counts[type] || 0 }))
    .filter(({ count }) => count > 0);

  if (channelTypes.length === 0) {
    log('No channels found on console for selected types.', 'warn');
    setBtn('fetch-names-btn', false);
    return;
  }

  for (const { type, count } of channelTypes) {
    log(`  ${type}: ${count} channels`, 'info');
  }

  // Step 2: fetch names
  const totalChannels = channelTypes.reduce((s, t) => s + t.count, 0);
  log(`Fetching names for ${totalChannels} channels…`, 'info');
  const result = await window.api.rcpGetChannelNames({ id: 'yamaha', channelTypes });

  if (!result.ok) {
    log(`Error fetching names: ${result.error}`, 'error');
    setBtn('fetch-names-btn', false);
    return;
  }

  // Step 3: fetch channel colors
  log('Fetching channel colors…', 'info');
  const colorResult = await window.api.rcpGetChannelColors({ id: 'yamaha', channelTypes });
  const channelColors = colorResult.ok ? colorResult.results : {};

  setBtn('fetch-names-btn', false);

  // Build channel list
  state.channels = [];
  for (const { type } of channelTypes) {
    const names = result.results[type] || [];
    const colors = channelColors[type] || [];
    for (const { index, name } of names) {
      const trackNum = getTrackNumForChannel(type, index, channelTypes);
      state.channels.push({
        type, index,
        yamahaName: name,
        reaperName: '',
        trackNum,
        status: 'loaded',
        selected: true,
        color: colors[index] || null
      });
    }
  }

  log(`Fetched ${state.channels.length} channels.`, 'ok');
  updateReaperNamesInTable();
  updateSelectionHint();
}

function getTrackNumForChannel(type, index, channelTypes) {
  // Map channels sequentially to REAPER tracks
  let offset = 1;
  for (const { type: t, count } of channelTypes) {
    if (t === type) return offset + index;
    offset += count;
  }
  return index + 1;
}

// Get sorted list of REAPER track numbers
function getSortedReaperTrackNums() {
  return Object.keys(state.reaperTracks).map(Number).sort((a, b) => a - b);
}

function updateReaperNamesInTable() {
  const sorted = getSortedReaperTrackNums();
  if (state.channels.length === 0) { renderTable(); return; }

  // Build reverse map: REAPER track name → track number
  const nameToTrackNum = {};
  for (const tn of sorted) {
    const name = state.reaperTracks[tn];
    if (name) nameToTrackNum[name] = tn; // last wins if duplicates
  }

  // Pass 1: match by name (primary strategy)
  const matchedTrackNums = new Set();
  for (const ch of state.channels) {
    if (ch.yamahaName && nameToTrackNum[ch.yamahaName] !== undefined) {
      const tn = nameToTrackNum[ch.yamahaName];
      ch._reaperAbsTrack = tn;
      ch.reaperName = ch.yamahaName;
      matchedTrackNums.add(tn);
    } else {
      ch._reaperAbsTrack = undefined;
      ch.reaperName = '';
    }
  }

  // Pass 2: position-based fallback for unmatched channels
  const unmatchedTracks = sorted.filter(tn => !matchedTrackNums.has(tn));
  let idx = 0;
  for (const ch of state.channels) {
    if (ch._reaperAbsTrack !== undefined) continue; // already matched by name
    if (idx < unmatchedTracks.length) {
      const tn = unmatchedTracks[idx++];
      ch._reaperAbsTrack = tn;
      ch.reaperName = state.reaperTracks[tn] || '';
    }
  }

  // Update status flags
  for (const ch of state.channels) {
    const differs = ch.yamahaName !== ch.reaperName && ch.reaperName !== '';
    if (differs) ch.status = 'changed';
  }

  renderTable();
}

// ─── Selection helpers ─────────────────────────────────────────────────────────────
function setAllSelected(val) {
  for (const ch of state.channels) ch.selected = val;
  renderTable();
  updateSelectionHint();
}

function updateSelectionHint() {
  const sel = state.channels.filter(c => c.selected).length;
  const total = state.channels.length;
  const hint = document.getElementById('sync-selection-hint');
  if (hint) hint.textContent = `${sel} of ${total} channels selected for sync.`;
  // Update header checkbox state
  const hdr = document.getElementById('select-all-hdr');
  if (hdr) {
    hdr.checked = sel === total && total > 0;
    hdr.indeterminate = sel > 0 && sel < total;
  }
}

// ─── Render table ─────────────────────────────────────────────────────────────
function renderTable() {
  const tbody = document.getElementById('channel-tbody');

  if (state.channels.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Connect to console and click Fetch to load channel data.</td></tr>';
    return;
  }

  tbody.innerHTML = '';

  for (const ch of state.channels) tbody.appendChild(makeChannelRow(ch));

  updateSelectionHint();
}

function makeChannelRow(ch) {
  const tr = document.createElement('tr');
  const nameDiffers = ch.yamahaName !== ch.reaperName && ch.reaperName !== '';
  const statusClass = nameDiffers ? 'changed' : (ch.status === 'ok' ? 'ok' : '');
  const swatchColor = ch.color || 'transparent';
  const typeLabel = ch.type === 'InCh' ? 'Mono' : ch.type === 'StInCh' ? 'St' : ch.type;

  if (ch.selected) tr.classList.add('ch-selected');

  tr.innerHTML = `
    <td class="col-cb">
      <input type="checkbox" class="ch-checkbox" ${ch.selected ? 'checked' : ''} />
    </td>
    <td class="col-color"><span class="color-swatch" style="background:${swatchColor}"></span></td>
    <td class="col-num"><span style="color:var(--text3);font-size:10px">${typeLabel}</span> ${ch.index + 1}</td>
    <td>${escapeHtml(ch.yamahaName) || '<span style="color:var(--text3)">—</span>'}</td>
    <td>${escapeHtml(ch.reaperName) || '<span style="color:var(--text3)">—</span>'}</td>
    <td class="col-status"><span class="status-dot ${statusClass}" title="${nameDiffers ? 'Names differ' : 'In sync'}"></span></td>
  `;

  if (nameDiffers) tr.style.background = 'rgba(245,166,35,0.04)';

  tr.querySelector('.ch-checkbox').addEventListener('change', (e) => {
    ch.selected = e.target.checked;
    tr.classList.toggle('ch-selected', ch.selected);
    updateSelectionHint();
  });

  return tr;
}

function clearTable() {
  state.channels = [];
  state.reaperTracks = {};
  renderTable();
  updateSelectionHint();
}

// ─── Sync ─────────────────────────────────────────────────────────────────────
async function doSync() {
  if (!state.yamahaConnected) { log('Yamaha not connected.', 'error'); return; }
  if (!state.reaperConnected) { log('REAPER not connected.', 'error'); return; }
  if (state.channels.length === 0) { log('No channel data. Fetch names first.', 'warn'); return; }
  if (!state.channels.some(c => c.selected)) { log('No channels selected. Check boxes in the table first.', 'warn'); return; }

  const syncBtn = document.getElementById('sync-btn');
  const syncIcon = document.getElementById('sync-btn-icon');
  syncBtn.disabled = true;
  syncIcon.classList.add('syncing');

  if (state.syncDirection === 'yamaha-to-reaper') {
    await syncYamahaToReaper();
  } else {
    await syncReaperToYamaha();
  }

  syncBtn.disabled = false;
  syncIcon.classList.remove('syncing');
  renderTable();
}

// Show the track-check modal and return a promise resolving to 'create'|'skip'|'cancel'
function showTrackModal(needed, existing, missing) {
  return new Promise((resolve) => {
    const modal = document.getElementById('track-modal');
    const msg   = document.getElementById('track-modal-msg');

    msg.innerHTML =
      `You are about to sync <strong>${needed}</strong> channel(s) to REAPER tracks 1–${needed}.<br><br>` +
      `REAPER currently has <strong>${existing}</strong> responding track(s).<br>` +
      `<strong>${missing}</strong> track(s) are missing.<br><br>` +
      `<em>"Create &amp; Sync"</em> will insert the missing tracks at the end of your REAPER project, then sync all names.<br>` +
      `<em>"Sync existing only"</em> will only rename tracks that already exist.`;

    modal.classList.remove('hidden');

    const cleanup = (result) => {
      modal.classList.add('hidden');
      document.getElementById('track-modal-create').removeEventListener('click', onCreate);
      document.getElementById('track-modal-skip').removeEventListener('click', onSkip);
      document.getElementById('track-modal-cancel').removeEventListener('click', onCancel);
      resolve(result);
    };
    const onCreate = () => cleanup('create');
    const onSkip   = () => cleanup('skip');
    const onCancel = () => cleanup('cancel');

    document.getElementById('track-modal-create').addEventListener('click', onCreate);
    document.getElementById('track-modal-skip').addEventListener('click', onSkip);
    document.getElementById('track-modal-cancel').addEventListener('click', onCancel);
  });
}

// Show existing tracks modal — returns 'overwrite'|'append'|'cancel'
function showExistingTracksModal(namedCount, selectedCount) {
  return new Promise((resolve) => {
    const modal = document.getElementById('existing-tracks-modal');
    const msg   = document.getElementById('existing-tracks-msg');

    msg.innerHTML =
      `REAPER already has <strong>${namedCount}</strong> track(s) with custom names.<br><br>` +
      `You are about to sync <strong>${selectedCount}</strong> Yamaha channel(s).<br><br>` +
      `<em>"Overwrite"</em> will rename the existing tracks with the Yamaha names.<br>` +
      `<em>"Add After Existing"</em> will create ${selectedCount} new track(s) after the existing ones.`;

    modal.classList.remove('hidden');

    const cleanup = (result) => {
      modal.classList.add('hidden');
      document.getElementById('existing-tracks-overwrite').removeEventListener('click', onOverwrite);
      document.getElementById('existing-tracks-append').removeEventListener('click', onAppend);
      document.getElementById('existing-tracks-cancel').removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOverwrite = () => cleanup('overwrite');
    const onAppend    = () => cleanup('append');
    const onCancel    = () => cleanup('cancel');

    document.getElementById('existing-tracks-overwrite').addEventListener('click', onOverwrite);
    document.getElementById('existing-tracks-append').addEventListener('click', onAppend);
    document.getElementById('existing-tracks-cancel').addEventListener('click', onCancel);
  });
}

async function syncYamahaToReaper() {
  const host     = document.getElementById('reaper-host').value.trim() || '127.0.0.1';
  const sendPort = parseInt(document.getElementById('reaper-send-port').value) || 8000;
  const selected = state.channels.filter(ch => ch.selected);

  if (selected.length === 0) return;

  // Ensure mapping is up to date
  updateReaperNamesInTable();

  // ── Check for existing named tracks in REAPER ──
  const namedTracks = Object.entries(state.reaperTracks).filter(([, name]) => name && name.trim() !== '');
  const namedCount = namedTracks.length;

  if (namedCount > 0) {
    const choice = await showExistingTracksModal(namedCount, selected.length);

    if (choice === 'cancel') {
      log('Sync cancelled.', 'info');
      return;
    }

    if (choice === 'append') {
      // Create new tracks after existing ones and sync to those
      const highestTrack = Math.max(...Object.keys(state.reaperTracks).map(Number), 0);
      log(`Creating ${selected.length} new track(s) after track ${highestTrack}…`, 'info');

      for (let i = 0; i < selected.length; i++) {
        await window.api.oscSend({
          id: 'reaper', targetHost: host, targetPort: sendPort,
          address: '/action/40001', args: [1]
        });
        await sleep(80);
      }
      await sleep(300);

      // Refresh track list to pick up the new tracks
      await requestReaperTrackNames({ clearFirst: true });
      await sleep(1500);
      updateReaperNamesInTable();
      log(`${selected.length} track(s) created.`, 'ok');

      // Now sync to the newly created tracks (those with numbers > highestTrack)
      const newTrackNums = Object.keys(state.reaperTracks)
        .map(Number)
        .filter(n => n > highestTrack)
        .sort((a, b) => a - b);

      log(`Syncing ${selected.length} channel names to new REAPER tracks…`, 'info');
      let success = 0, failed = 0;

      for (let i = 0; i < selected.length; i++) {
        const ch = selected[i];
        if (!ch.yamahaName) continue;
        const targetTrack = newTrackNums[i] || (highestTrack + i + 1);

        const result = await window.api.oscSend({
          id: 'reaper', targetHost: host, targetPort: sendPort,
          address: `/track/${targetTrack}/name`,
          args: [ch.yamahaName]
        });

        if (result.ok) {
          ch.status = 'ok';
          ch.reaperName = ch.yamahaName;
          success++;
        } else {
          ch.status = 'error';
          failed++;
          log(`Failed to set REAPER track ${targetTrack}: ${result.error}`, 'error');
        }
        if (success % 10 === 0) await sleep(10);
      }

      const parts = [`${success} sent to REAPER`];
      if (failed > 0) parts.push(`${failed} failed`);
      log(`Sync complete: ${parts.join(', ')}.`, success > 0 ? 'ok' : 'warn');
      return;
    }

    // choice === 'overwrite' — fall through to normal sync below
  }

  // ── Normal sync: overwrite existing tracks ──
  let skipMissing = false;

  const existingCount = selected.filter(ch => ch._reaperAbsTrack !== undefined).length;
  const missingCount = selected.length - existingCount;
  log(`Checking REAPER tracks: ${existingCount} found, ${missingCount} missing…`, 'info');

  if (missingCount > 0) {
    const choice = await showTrackModal(selected.length, existingCount, missingCount);

    if (choice === 'cancel') {
      log('Sync cancelled.', 'info');
      return;
    }

    if (choice === 'skip') skipMissing = true;

    if (choice === 'create') {
      log(`Creating ${missingCount} missing track(s) in REAPER…`, 'info');
      for (let i = 0; i < missingCount; i++) {
        await window.api.oscSend({
          id: 'reaper', targetHost: host, targetPort: sendPort,
          address: '/action/40001', args: [1]
        });
        await sleep(80);
      }
      await sleep(300);
      await requestReaperTrackNames({ clearFirst: true });
      await sleep(1500);
      updateReaperNamesInTable();
      log(`${missingCount} track(s) created.`, 'ok');
    }
  }

  // ── Perform sync ──
  log(`Syncing ${selected.length} channel names: Yamaha → REAPER…`, 'info');
  let success = 0, skipped = 0, failed = 0;

  for (const ch of selected) {
    if (!ch.yamahaName) continue;

    const absTrack = ch._reaperAbsTrack;

    if (skipMissing && absTrack === undefined) {
      skipped++;
      continue;
    }

    const targetTrack = absTrack !== undefined ? absTrack : ch.trackNum;

    const result = await window.api.oscSend({
      id: 'reaper', targetHost: host, targetPort: sendPort,
      address: `/track/${targetTrack}/name`,
      args: [ch.yamahaName]
    });

    if (result.ok) {
      ch.status = 'ok';
      ch.reaperName = ch.yamahaName;
      success++;
    } else {
      ch.status = 'error';
      failed++;
      log(`Failed to set REAPER track ${targetTrack}: ${result.error}`, 'error');
    }

    if (success % 10 === 0) await sleep(10);
  }

  const parts = [`${success} sent to REAPER`];
  if (skipped > 0) parts.push(`${skipped} skipped (track didn't exist)`);
  if (failed > 0)  parts.push(`${failed} failed`);
  log(`Sync complete: ${parts.join(', ')}.`, success > 0 ? 'ok' : 'warn');
}

async function syncReaperToYamaha() {
  const selected = state.channels.filter(ch => ch.selected);
  log(`Syncing ${selected.length} track names: REAPER → Yamaha…`, 'info');

  // Ensure position-based mapping is up to date
  updateReaperNamesInTable();

  let success = 0, failed = 0;

  for (const ch of selected) {
    const absTrack = ch._reaperAbsTrack;
    const reaperName = absTrack !== undefined ? state.reaperTracks[absTrack] : undefined;
    if (!reaperName) continue;

    const result = await window.api.rcpSetChannelName({
      id: 'yamaha',
      type: ch.type,
      index: ch.index,
      name: reaperName
    });

    if (result.ok) {
      ch.yamahaName = reaperName;
      ch.status = 'ok';
      success++;
    } else {
      ch.status = 'error';
      failed++;
      log(`Failed to set Yamaha ${ch.type} ch${ch.index + 1}: ${result.error}`, 'error');
    }

    if (success % 5 === 0) await sleep(20);
  }

  log(`Sync complete: ${success} set on Yamaha${failed > 0 ? `, ${failed} failed` : ''}.`, success > 0 ? 'ok' : 'warn');
}

// ─── Network scan ─────────────────────────────────────────────────────────────
async function startScan() {
  const ifaceAddr = document.getElementById('iface-select').value;
  if (!ifaceAddr) { log('Select a network interface first.', 'error'); return; }

  const port = parseInt(document.getElementById('yamaha-port').value) || 49280;

  state.scanCancelled = false;
  document.getElementById('scan-overlay').classList.remove('hidden');
  document.getElementById('scan-progress-text').textContent = `Scanning ${ifaceAddr.split('.').slice(0,3).join('.')}.0/24 on port ${port}…`;

  log(`Scanning for Yamaha consoles on ${ifaceAddr} (port ${port})…`, 'info');

  const result = await window.api.scanHosts({ subnet: ifaceAddr, port });

  document.getElementById('scan-overlay').classList.add('hidden');

  if (!result.ok) {
    log(`Scan error: ${result.error}`, 'error');
    return;
  }

  const hosts = result.hosts;
  const scanResults = document.getElementById('scan-results');
  const scanList = document.getElementById('scan-list');
  scanList.innerHTML = '';

  if (hosts.length === 0) {
    log('No Yamaha consoles found on this network.', 'warn');
    scanResults.classList.remove('hidden');
    scanList.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:4px 0">No devices found.</div>';
    return;
  }

  log(`Found ${hosts.length} device(s). Querying device names…`, 'ok');
  scanResults.classList.remove('hidden');

  // Query each host for its RCP device name in parallel
  await Promise.all(hosts.map(async (host) => {
    const div = document.createElement('div');
    div.className = 'scan-item';
    div.innerHTML = `
      <div class="scan-item-info">
        <span class="scan-item-name">⏳ Querying…</span>
        <span class="scan-item-ip">${host}</span>
      </div>
      <button class="btn btn-primary btn-sm">Use</button>
    `;
    scanList.appendChild(div);

    // Try to get device name via RCP
    let deviceName = '';
    try {
      const connId = `scan-${host}`;
      const conn = await window.api.rcpConnect({ id: connId, host, port });
      if (conn.ok) {
        const r = await window.api.rcpSend({ id: connId, command: 'get MIXER:Current/InCh/Label/Name 0 0' });
        if (r.ok && r.response && r.response.startsWith('OK')) {
          // Also try to get a system name if available
          const r2 = await window.api.rcpSend({ id: connId, command: 'get MIXER:Current/MixerSetup/TitleName 0 0' });
          if (r2.ok && r2.response && r2.response.startsWith('OK')) {
            const m = r2.response.match(/"([^"]*)"/); 
            if (m && m[1]) deviceName = m[1];
          }
          if (!deviceName) deviceName = 'Yamaha Console';
        }
        await window.api.rcpDisconnect({ id: connId });
      }
    } catch {}

    const nameEl = div.querySelector('.scan-item-name');
    nameEl.textContent = deviceName || 'Yamaha Console';

    div.querySelector('button').addEventListener('click', () => {
      document.getElementById('yamaha-ip').value = host;
      localStorage.setItem('yamaha-last-ip', host);
      scanResults.classList.add('hidden');
      log(`Selected ${deviceName ? deviceName + ' at ' : ''}${host}`, 'info');
    });
  }));
}

// ─── Connection tests ─────────────────────────────────────────────────────────
async function testYamaha() {
  const host = document.getElementById('yamaha-ip').value.trim();
  const port = parseInt(document.getElementById('yamaha-port').value) || 49280;
  const results = document.getElementById('test-results');

  if (!host) {
    showTestResult('❌ No IP address entered.', 'fail');
    return;
  }

  results.innerHTML = '<span class="test-warn">⏳ Testing Yamaha connection…</span>';

  // Step 1: TCP connect
  log(`Testing Yamaha at ${host}:${port}…`, 'info');
  const conn = await window.api.rcpConnect({ id: 'yamaha-test', host, port });

  if (!conn.ok) {
    showTestResult(
      `❌ TCP connection failed: ${conn.error}\n\nTroubleshooting:\n• Is the console powered on?\n• Is the IP address correct?\n• Is your computer on the same network?\n• Check console Network settings (port must be 49280)`,
      'fail'
    );
    log(`Yamaha test FAILED: ${conn.error}`, 'error');
    return;
  }

  // Step 2: Send a get command and check for OK response
  const getResult = await window.api.rcpSend({
    id: 'yamaha-test',
    command: 'get MIXER:Current/InCh/Label/Name 0 0'
  });

  await window.api.rcpDisconnect({ id: 'yamaha-test' });

  if (getResult.ok && getResult.response && getResult.response.startsWith('OK')) {
    const match = getResult.response.match(/"([^"]*)"/);
    const name = match ? match[1] : '(empty)';
    showTestResult(`✅ Connected! Channel 1 name: "${name}"`, 'ok');
    log(`Yamaha test OK — Ch1 name: "${name}"`, 'ok');
  } else if (getResult.ok) {
    showTestResult(`⚠️ Connected but unexpected response: ${getResult.response}`, 'warn');
    log(`Yamaha test: unexpected response: ${getResult.response}`, 'warn');
  } else {
    showTestResult(`⚠️ Connected but no response to query: ${getResult.error}\n\nCheck that Remote Control is enabled on the console.`, 'warn');
    log(`Yamaha test: no response: ${getResult.error}`, 'warn');
  }
}

async function testReaper() {
  const host = document.getElementById('reaper-host').value.trim() || '127.0.0.1';
  const sendPort = parseInt(document.getElementById('reaper-send-port').value) || 8000;
  const listenPort = parseInt(document.getElementById('reaper-listen-port').value) || 9000;

  if (!state.reaperConnected) {
    showTestResult('❌ OSC listener not started. Click "Connect" under REAPER first.', 'fail');
    return;
  }

  document.getElementById('test-results').innerHTML = '<span class="test-warn">⏳ Sending test OSC to REAPER…</span>';
  log(`Testing REAPER OSC at ${host}:${sendPort}…`, 'info');

  // Request track 1 name
  const result = await window.api.oscSend({
    id: 'reaper',
    targetHost: host,
    targetPort: sendPort,
    address: '/track/1/name',
    args: []
  });

  if (!result.ok) {
    showTestResult(`❌ Failed to send OSC: ${result.error}`, 'fail');
    return;
  }

  // Wait briefly for reply
  await sleep(800);

  const track1Name = state.reaperTracks[1];
  if (track1Name !== undefined) {
    showTestResult(
      `✅ REAPER responding! Track 1 name: "${track1Name}"\n\nOSC connection working correctly.`,
      'ok'
    );
    log(`REAPER test OK — Track 1: "${track1Name}"`, 'ok');
  } else {
    showTestResult(
      `⚠️ OSC sent, no reply yet.\n\nTroubleshooting:\n• In REAPER: Options → Settings → Control/OSC/Web → Add\n• Choose OSC (Open Sound Control)\n• Set "Mode" to send/receive\n• Local listen port: ${sendPort}\n• Send to: this computer IP, port ${listenPort}\n• Click Apply/OK and try again.`,
      'warn'
    );
    log(`REAPER test: no OSC reply received (may need REAPER config).`, 'warn');
  }
}

async function reaperAutoConfigure() {
  const rcvPort = parseInt(document.getElementById('reaper-listen-port').value) || 9000;
  const sndPort = parseInt(document.getElementById('reaper-send-port').value) || 8000;

  log(`Auto-configuring REAPER OSC (rcv: ${rcvPort}, snd: ${sndPort})…`, 'info');
  setBtn('reaper-autoconfig-btn', true);

  const result = await window.api.reaperAutoConfigure({ rcvPort, sndPort });

  setBtn('reaper-autoconfig-btn', false);

  if (!result.ok) {
    showTestResult(`❌ Auto-configure failed:\n\n${result.error}`, 'fail');
    log(`REAPER auto-configure failed: ${result.error}`, 'error');
    return;
  }

  if (result.alreadyExists) {
    showTestResult(`✅ REAPER OSC already configured with these ports.\n\nNo changes needed.`, 'ok');
    log('REAPER OSC entry already exists — no changes made.', 'ok');
    return;
  }

  showTestResult(
    `✅ REAPER OSC configured successfully!\n\nEntry added to reaper.ini.\nA backup was saved as reaper.ini.bak\n\n⚠️ You must restart REAPER for the change to take effect.\n\nAfter restart:\n1. Open or create a project in REAPER\n2. Make sure it has tracks (they are NOT created automatically)\n3. Click Connect in this app, then ↺ to load track names`,
    'ok'
  );
  log(`REAPER OSC entry written to ${result.iniPath} — restart REAPER to activate.`, 'ok');
}

function showTestResult(msg, type) {
  const el = document.getElementById('test-results');
  const cssClass = type === 'ok' ? 'test-ok' : type === 'fail' ? 'test-fail' : 'test-warn';
  el.innerHTML = `<pre class="${cssClass}" style="white-space:pre-wrap;font-family:inherit;font-size:11px;line-height:1.6">${escapeHtml(msg)}</pre>`;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function updateUI() {
  const yaConn = state.yamahaConnected;
  const reConn = state.reaperConnected;

  // Status dots
  document.getElementById('yamaha-status-dot').className = `status-indicator ${yaConn ? 'connected' : ''}`;
  document.getElementById('reaper-status-dot').className = `status-indicator ${reConn ? 'connected' : ''}`;

  // Badges
  setBadge('yamaha-badge', yaConn ? 'Connected' : 'Disconnected', yaConn ? 'connected' : '');
  setBadge('reaper-badge', reConn ? 'Connected' : 'Disconnected', reConn ? 'connected' : '');

  // Buttons
  document.getElementById('yamaha-connect-btn').disabled = yaConn;
  document.getElementById('yamaha-disconnect-btn').disabled = !yaConn;
  document.getElementById('reaper-connect-btn').disabled = reConn;
  document.getElementById('reaper-disconnect-btn').disabled = !reConn;
  document.getElementById('fetch-names-btn').disabled = !yaConn;
  document.getElementById('sync-btn').disabled = !(yaConn && reConn);
  document.getElementById('reaper-refresh-btn').disabled = !reConn;
}

function setBadge(id, text, extraClass) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `badge${extraClass ? ' ' + extraClass : ''}`;
}

function setBtn(id, disabled) {
  document.getElementById(id).disabled = disabled;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // App
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Network interfaces
  getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),

  // Yamaha RCP
  rcpConnect: (opts) => ipcRenderer.invoke('rcp-connect', opts),
  rcpDisconnect: (opts) => ipcRenderer.invoke('rcp-disconnect', opts),
  rcpSend: (opts) => ipcRenderer.invoke('rcp-send', opts),
  rcpProbeCounts: (opts) => ipcRenderer.invoke('rcp-probe-counts', opts),
  rcpGetChannelNames: (opts) => ipcRenderer.invoke('rcp-get-channel-names', opts),
  rcpGetChannelColors: (opts) => ipcRenderer.invoke('rcp-get-channel-colors', opts),
  rcpSetChannelName: (opts) => ipcRenderer.invoke('rcp-set-channel-name', opts),

  // OSC
  oscStart: (opts) => ipcRenderer.invoke('osc-start', opts),
  oscStop: (opts) => ipcRenderer.invoke('osc-stop', opts),
  oscSend: (opts) => ipcRenderer.invoke('osc-send', opts),

  // Network scan
  scanHosts: (opts) => ipcRenderer.invoke('scan-hosts', opts),

  // REAPER auto-configure
  reaperAutoConfigure: (opts) => ipcRenderer.invoke('reaper-auto-configure', opts),

  // Events from main → renderer
  on: (channel, fn) => {
    const allowed = ['rcp-data', 'rcp-error', 'rcp-closed', 'rcp-notify', 'osc-message', 'osc-error'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => fn(...args));
    }
  },
  off: (channel, fn) => {
    ipcRenderer.removeListener(channel, fn);
  }
});

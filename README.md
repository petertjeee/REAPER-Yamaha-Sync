# REAPER ↔ Yamaha Channel Sync

Sync channel names between **Yamaha DM7 / QL series** mixing consoles and the **REAPER** DAW.  
Runs on **macOS** and **Windows** as a self-contained desktop application — no extra software to install.

---

## Installation

Download the latest release from the [Releases page](https://github.com/petertjeee/REAPER-Yamaha-Sync/releases).

### macOS

1. Download the `.zip` for your Mac:
   - **Apple Silicon** (M1/M2/M3/M4): `...-mac-arm64.zip`
   - **Intel**: `...-mac-x64.zip`
2. Extract the zip and move **REAPER-Yamaha Sync.app** to your Applications folder.
3. On first launch, macOS will block the app (*"Apple could not verify…"*). To fix this, open **Terminal** and run:
   ```bash
   xattr -cr /Applications/REAPER-Yamaha\ Sync.app
   ```
4. Now open the app normally. This is only needed once.

> This is required because the app is not signed with an Apple Developer certificate. The command removes the macOS quarantine flag.

### Windows

1. Download the `.zip` file and extract it to a folder of your choice (e.g. `C:\Program Files\REAPER-Yamaha Sync`).
2. Run **REAPER-Yamaha Sync.exe** from the extracted folder.
3. Windows SmartScreen may show *"Windows protected your PC"* — click **More info** → **Run anyway**. This is only needed once.

---

## How it works

| Component | Protocol | Details |
|---|---|---|
| Yamaha Console | **RCP over TCP** | Port `49280`, newline-delimited text commands |
| REAPER | **OSC over UDP** | REAPER sends track names on its configured port, receives on another |

### Yamaha RCP
Yamaha QL/DM7/CL consoles expose a Remote Control Protocol (RCP) on TCP port 49280.  
Channel names are read/written with:
```
get MIXER:Current/InCh/Label/Name <ch> 0
set MIXER:Current/InCh/Label/Name <ch> 0 "Name"
```
Supported channel types: `InCh` (mono inputs), `StInCh` (stereo inputs), `Mix` (mix buses).

### REAPER OSC
REAPER's built-in OSC control surface sends and receives track names as:
```
/track/N/name  (string)
```

---

## REAPER Setup (required)

### Option A — Automatic (recommended)

Click **⚙️ Auto-configure REAPER OSC** in the app. This directly edits `reaper.ini` to add the correct OSC control surface entry (same method used by MarkerMatic). A backup of `reaper.ini` is created automatically.

**Restart REAPER after using this button** for the change to take effect.

### Option B — Manual

1. Open REAPER → **Options → Settings → Control/OSC/Web**
2. Click **Add** → choose **OSC (Open Sound Control)**
3. Set:
   - **Mode**: `Configure device IP + local port`
   - **Device IP**: `127.0.0.1`
   - **Device port**: match the **"REAPER OSC Listen Port"** in this app (default: `9000`)
   - **Local listen port**: match the **"REAPER OSC Send Port"** in this app (default: `8000`)
4. Click **OK** and **Apply**

The help box in the app always shows the correct port values based on your current settings.

---

## Yamaha Console Setup

1. On the console, go to **Setup → Network** and note the IP address.
2. Ensure **Remote Control** (SCP) is enabled — it is on by default on QL/DM7.
3. Port `49280` must be reachable from your computer (same LAN or direct connection).

---

## Usage

1. **Enter the console IP** or click 🔍 to auto-scan your network.
2. Click **Connect** under Yamaha Console.
3. Click **Connect** under REAPER (starts the OSC listener).
4. Select which **channel types** to sync (Mono Inputs, Stereo Inputs, etc.).
5. Click **Fetch Names** to load all channel names from the console.
6. Choose sync direction:
   - **Yamaha → REAPER**: copies console channel names to REAPER track names
   - **REAPER → Yamaha**: copies REAPER track names to console channel names
7. Click **⇄ Sync Now**.

Use **Connection Test** to diagnose issues with either connection.

### REAPER Track Detection

The app reads REAPER track names via OSC using 8-track banks. It automatically iterates through all banks to collect every track in the project. Tracks are identified by their **custom name** — tracks with default names (e.g. `Track 1`, `Track 2`) are ignored, as REAPER always reports 256 track slots regardless of how many actual tracks exist.

---

## Building from source

```bash
npm install
npm start          # run in development
npm run build:mac  # build macOS .dmg
npm run build:win  # build Windows installer
npm run build:all  # build both
```

Requires [Node.js](https://nodejs.org/) 18+ and [npm](https://www.npmjs.com/).  
Distributed builds are self-contained — end users do **not** need Node.js installed.

---

## Channel count reference

| Console | Mono In | Stereo In | Mix Buses |
|---|---|---|---|
| QL1 / QL5 | 32 | 8 | 16 |
| DM7 / DM7 Compact | 120 | 8 | 24 |
| CL1 / CL3 / CL5 | 72 | 8 | 24 |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Connection timed out" on Yamaha | Check IP, ensure console is on the same LAN, port 49280 not blocked |
| "No reply" from REAPER | Configure OSC control surface in REAPER preferences (see above) |
| Names don't update in REAPER | Re-apply OSC config: Options → Settings → Plug-ins → Control/OSC/Web |
| DM7 returns empty names | Some channels may have no label set — that is normal |
| Sync only works one way | REAPER track names require OSC `/track/N/name` with a string argument |

# Ski Stream Overlay

An installable OBS plugin for alpine ski racing overlays: the racer on course, their running time and category standings. Run OBS normally on macOS and use the optional Docker simulator to test a competition.

The plugin adds a **Ski Race Overlay** source to OBS. Each source displays either the racer on course or a category's top 10. The plugin starts its bundled local service and renders transparent graphics through OBS's browser engine.

The race-control interface currently uses Finnish labels. The instructions below include those exact labels alongside their English meaning.

## Install on an Apple Silicon Mac

Build the package first using the development instructions below. This produces `dist/SkiRaceOverlay.plugin` for Apple Silicon and OBS 33.0.1. OBS must include Browser Source support. This repository contains source code, not a ready-made installation package.

1. Close OBS.
2. Open Terminal and run:

   ```bash
   cd /path/to/ski-stream-overlay
   bash scripts/install-plugin.sh
   ```

3. Open OBS and add **Sources → + → Ski Race Overlay**.
4. Select **Display → Racer on course** and click **Open race control — connection, CSV and demo**.
5. The control panel opens at <http://127.0.0.1:8787>.

The installer copies the package into `~/Library/Application Support/obs-studio/plugins/`. It moves an existing version to a timestamped backup first. The package includes Node.js, so no separate npm installation is needed.

## First test without VOLA

1. In race control, select **Tietolähde → Demo** (Data source → Demo) and click **Tallenna ja yhdistä** (Save and connect).
2. Click **Käynnistä demo** (Start demo). Racers advance automatically, with a running clock before each finish.
3. Add another **Ski Race Overlay** source in OBS. Select **Display → Category top 10** and enter `Demo` as the category.
4. Click **Seuraava laskija** (Next racer) in race control to add a test result immediately.
5. Place a camera or other video source below the graphics and check transparency.

The demo uses synthetic racers in the `Demo` category. The first racer is always fastest. Demo results and the demo roster are separate from live race data. **Pysäytä** (Stop) pauses the demo; **Nollaa demo** (Reset demo) clears its results.

The canvas is 1920 × 1080. The racer graphic appears along the bottom, with a category badge beside the racer details and the club below the name. Competition naming and the **DEMO**/**TESTI** markers are separate from the category. Each top 10 source can display a different category; an empty category field selects the first available category. To follow the current racer or latest finisher automatically, enter `auto` as the category or use `http://127.0.0.1:8787/overlay/top10?category=auto`. Automatic mode shows no category standings when that racer has no category.

## Automatic race coverage

Select **Display → Automatic race coverage** in the OBS source properties, or use `http://127.0.0.1:8787/overlay/auto`. This view switches between racers and results without reloading the page. Manual racer and category top 10 views remain available.

Each active bib has its own running clock. The oldest active racer occupies the main lower-third; additional racers appear in compact rows showing only bib, optional name and estimated time. A finish, DNF or DSQ takes the main position for the configured display time, then leaves the stack. Closely spaced terminal events are shown in order. DNF and DSQ are statuses, not ranked finish times.

When no racers remain on course and all terminal displays have completed, the overlay shows the most recent terminal racer's category standings. Once the configured time since the last start has elapsed, it cycles through categories with ranked results. Racers still waiting to start do not prevent cycling. Any new start immediately restores the racer view; cycling never covers racers still on course.

Race control provides three saved timing settings beside the roster controls:

| Setting                                               | Default     |
| ----------------------------------------------------- | ----------- |
| Finish / DNF / DSQ display duration                   | 2 seconds   |
| Time since the last start before idle results cycling | 180 seconds |
| Display duration for each category in the cycle       | 10 seconds  |

A missing finish is not automatically classified as DNF. Terminal statuses must arrive from the feed. Verify the VOLA status-code mapping with the timing operator before the race; Kiril's public parser does not document DNF or DSQ codes. JSON feeds can send explicit `dnf` and `dsq` event types.

## Competitor roster

Set **Kilpailun nimi** (Competition name) above the CSV import controls and click **Tallenna kilpailun nimi** (Save competition name). The optional name appears on both overlays, independently of the category and DEMO/TESTI markers. It defaults to blank; saving an empty value hides it. Use up to 120 characters without control characters. Saving the competition name keeps the timing connection running.

Select the competition discipline beside the competition name and CSV controls: **GS**, **SL**, **TAITO**, **SG**, **SUP**, **DH** or **Other**. The saved discipline appears as a red badge separate from the racer's category and DEMO/TESTI marker. **Other** is the default and hides only the discipline badge. Saving the discipline keeps active clocks and the timing connection running.

Import a roster in **Kilpailijat** (Competitors) by uploading a file, pasting roster text or entering an HTTP(S) roster URL. CSV and tab-separated VOLA TXT exports are accepted, including title lines and the final competitor count. UTF-8 (with or without BOM) and Windows-1252 files preserve accented names. The URL must return the file directly. **Hae lista** (Fetch roster) saves a local copy; the service does not keep polling that URL.

```csv
bib,name,category,club
001,Racer 001,U12 Girls,Example Ski Club
002,Racer 002,U12 Boys,
```

- Only the `bib` column and each row's bib value are required. The optional columns are `name`, `category`, `club` and `yearOfBirth` (a four-digit year; VOLA uses `Year`). VOLA `Code` values are ignored.
- Existing three-column `bib,name,category` files still work. CSV downloads include all four standard columns and add `yearOfBirth` when the roster contains it. The optional birth year appears beside the club below the skier name in the main lower third; compact racer stacks and top 10 stay concise.
- Missing optional columns or empty values remain blank in the overlay; no placeholder name, category or club is invented.
- Commas, semicolons and tabs are accepted as separators. Quote names containing commas.
- Bibs must be unique across the roster. `001` and `1` are different bibs: the CSV value must match the timing feed exactly.
- Enter the category in the OBS source settings exactly as it appears in the CSV.
- An unknown bib shows its bib and time with blank name, category and club. Racers without a category do not appear in category standings or receive a rank.
- An invalid import is rejected in full, keeping the previous roster.

Reimporting updates names, categories and clubs for results already received. **Lataa nykyinen CSV** (Download current CSV) downloads the active roster. With **Testisyöte** (Test feed) enabled, imports and results use a separate test race and the overlay displays **TESTI** (TEST).

## Connect to VOLA timing

[Kiril's original program](https://github.com/jovchev/vola-skialppro-text-overlay) reads names from VOLA's SQLite database, listens for timing events on TCP port 5409 and writes three text files. It does not expose its own database or HTTP service.

This plugin consumes the TCP events directly and gets names and categories from CSV. Kiril's original program does not need to run alongside it just to relay data.

1. Confirm that VOLA broadcasts timing events and the timing PC's firewall allows the connection.
2. Select **Tietolähde → TCP-yhteys** (Data source → TCP connection). Disable **Testisyöte** (Test feed) for a real race.
3. Save the settings and import the real competitor CSV.
4. Select **TCP-tietomuoto → VOLA / NR-protokolla (kokeellinen)** (TCP format → VOLA / NR protocol, experimental).
5. Enter the timing PC's address or hostname and port; the default port is `5409`.
6. Click **Tallenna ja yhdistä** (Save and connect), then send a new start and finish from VOLA.

Enter only the address or hostname, such as `timing-pc.local`, in the host field. The port has its own field. Both computers must be able to communicate; sharing a Wi-Fi network name alone does not guarantee connectivity.

**The VOLA adapter is experimental.** Message interpretation is inferred from Kiril's public code, not a confirmed protocol for the current VOLA version. The default mapping recognizes status `0` as start and `1` as finish; other numeric codes are ignored unless configured in the advanced VOLA status mapping in race control. This replaces the earlier assumption that every nonzero code was a finish. Confirm any additional finish, DNF and DSQ codes before using them. Verify start, finish, bib formatting and any intermediate timing messages before race use. Kiril reported that the free VOLA version allows a limited test with up to 20 finish records; that product limit has not been independently verified here.

## Timing and standings

During a run, the clock is marked **ARVIOITU AIKA** (ESTIMATED TIME): it advances locally after a start event. At a VOLA finish, the result is calculated from the feed's finish and start timestamps.

The top 10 sorts times from fastest to slowest within each category. Each row shows the racer's time and gap behind that category's current leader. It uses the **last finish received for each bib**, so a correction replaces an earlier time. This version does not calculate a two-run total or choose a racer's best attempt. Clear live results through the control panel's confirmation prompt before starting another race or separate run.

After a finish, the racer graphic shows the rank within that racer's own category. Ties share a rank and leave a gap before the next rank, for example **1, 1, 3**. A slower result shows a positive gap in red; a new leader shows a negative gap in green compared with the previous leader. A tie shows zero. The first finisher has no comparison time and displays **JOHDOSSA** (IN THE LEAD). During a run, no finish rank or leader comparison is shown. Without a category, the racer's time remains visible but no rank or gap is calculated.

When a disconnect is detected, the running clock freezes and the overlay reports the interruption. Silence between start and finish events is allowed; detecting a broken TCP connection may take time. Restarting restores saved results, roster and settings, but not a run in progress. Connecting to VOLA during a run waits for the next start because the missing start time is unknown. `S` on-course lists are not yet used.

## Test competition in Docker

The simulator sends synthetic start and finish events over one TCP connection in the VOLA format inferred from Kiril's code. It lets you test the connection, roster and OBS graphics together. It does not include VOLA, its database or captured hardware packets.

Start Docker Desktop, then run from the project directory:

```bash
docker compose -f simulator/compose.yaml up --build -d
```

You can run the same simulator directly with Node.js 20 or newer:

```bash
node simulator/server.mjs
```

Use one launch method at a time. The simulator uses TCP port `5409` and control-panel port `8790`, so stop any running `examples/mock-feed.mjs` instance first.

1. Open OBS race control at <http://127.0.0.1:8787>.
2. Expand **Testaa Docker-kilpailusimulaattorilla** (Test with the Docker competition simulator) and click **Täytä paikallisen simulaattorin asetukset** (Fill local simulator settings).
3. Click **Tallenna ja yhdistä** (Save and connect). The preset selects TCP, VOLA format, `127.0.0.1`, port `5409` and **Testisyöte** (Test feed).
4. Click **Hae lista** (Fetch roster). The preset roster URL is <http://127.0.0.1:8790/competitors.csv>.
5. Set the top 10 source's category to `Demo`.
6. Open <http://127.0.0.1:8790> and start the competition. Connect OBS before the first start: joining during a run waits for the next start.

The roster has nine synthetic competitors. The first finishes in `30.00`; all others are slower. The overlay displays **TESTI** (TEST). The test roster and results are stored separately from the live race.

The simulator starts paused at **1×** speed. Starting continues racers in order. Pause lets the current racer finish before stopping. Next immediately sends either the next start or the current racer's finish. Reset restores the starting order and disconnects test clients; OBS reconnects automatically. **Resetting the simulator does not clear overlay standings**: reset test results separately in race control.

Speed settings from **1–100×** shorten the test. Use **1×** to check the running clock: OBS's estimate follows real elapsed time and falls behind an accelerated simulation. Synthetic finish times remain the same at every speed.

Stop the Docker version with:

```bash
docker compose -f simulator/compose.yaml down
```

Stop the Node.js version with `Ctrl+C` in Terminal. Docker ports are published only on the host's localhost interface.

## TCP test feed and HTTP alternative

Use the standalone feed to test a real TCP connection without VOLA:

```bash
cd /path/to/ski-stream-overlay
node examples/mock-feed.mjs
```

Select **TCP-yhteys → JSON-viestit riveittäin** (TCP connection → JSON events, one per line), host `127.0.0.1`, port `5409` and **Testisyöte** (Test feed). Save and import `examples/competitors.csv`. Open the simulator panel at <http://127.0.0.1:8790> and start the competition; the feed starts paused. It uses the Docker simulator's racers and controls but sends JSON events. Stop it with `Ctrl+C`.

HTTP / JSON mode accepts a separate service URL and polling interval. Use it with your own timing bridge; Kiril's original project does not provide this endpoint. See [PROTOCOL.md](PROTOCOL.md) for message formats and limits.

## Development and troubleshooting

Run the service without OBS using Node.js 20 or newer:

```bash
node server.mjs
```

Open <http://127.0.0.1:8787>. Standalone development stores data in the project's `data/` directory. On macOS, the OBS-managed service uses `~/Library/Application Support/ski-stream-overlay/`, containing `state.json` and `service.log`. Port 8787 is for local control; the timing feed uses a separate port.

If race control does not open, check `service.log` and the OBS log's `SkiRaceOverlay` entries. The plugin will not start its service if another application owns port 8787. If the source is missing from OBS's menu, check the installation directory and restart OBS.

Rebuild the package after source changes. You need OBS 33.0.1, Apple's C++ compiler and an arm64 Node.js runtime with its matching LICENSE file:

```bash
bash scripts/build-plugin.sh
```

The first build downloads OBS and SIMDe source headers from their official GitHub projects. It signs the package locally with an ad hoc signature. To use existing source directories, set `OBS_SOURCE_DIR` and `SIMDE_SOURCE_DIR`; set `NODE_BINARY` to choose a Node executable.

Run the focused backend tests with:

```bash
node --test test/backend.test.mjs
```

These cover CSV imports, result corrections, ties, disconnected clocks, split TCP messages and local HTTP persistence. After building the package, run `bash scripts/build-plugin-test.sh` to test native source creation and lifecycle against the OBS library. This does not replace a visual check in OBS. Verify the real VOLA feed with the actual timing setup.

## Windows build and installation (UNTESTED)

Windows x64 source support and build/install scripts are included. **No Windows DLL has been compiled or run yet.** The macOS build and lifecycle tests pass, but they do not validate Winsock, Windows process handling, PowerShell or rendering in Windows OBS. The existing `.plugin` bundle is for macOS only.

### Requirements

- Windows x64 with OBS Studio **33.0.1** and its Browser Source component. Windows ARM64 is not a supported build target.
- Visual Studio **2026**, with **Desktop development with C++** and Windows SDK **10.0.26100.0**; CMake **4.2 or newer** and Git.
- A complete **OBS 33.0.1 x64 exported development SDK**. This must supply `libobsConfig.cmake`, `libobsConfigVersion.cmake`, the `OBS::libobs` target, matching `obs.lib`, generated headers (including `obsconfig.h`), SIMDe and w32-pthreads dependency packages. The OBS application installer alone does not supply this SDK.
- Windows x64 Node.js **20 or newer**, preferably a supported LTS release, and its matching `LICENSE`. Both are bundled in the plugin; end users do not need a separate Node installation.

To prepare the SDK, build the OBS `33.0.1` source tag on Windows following the [official OBS build instructions](https://github.com/obsproject/obs-studio/wiki/build-instructions-for-windows), and install/export its development artifacts into an SDK prefix. Preserve the dependency packages from that build. Point `-ObsSdkDir` below to the prefix containing the exported libobs CMake package. If dependencies live in separate prefixes, pass them to `-DependencyPrefix` (an array of paths). Raw source headers plus an unrelated DLL/import library are insufficient. SDK preparation and the commands below still need validation on a Windows machine.

For a source-built SDK, run these commands in the OBS source checkout after its dependencies have been prepared following that guide:

```powershell
cmake --preset windows-x64
cmake --build --preset windows-x64 --config RelWithDebInfo
cmake --install build_x64 --config RelWithDebInfo --component Development --prefix 'C:\obs-sdk-33.0.1-x64'
```

Retain the matching dependency directories from that build for `-DependencyPrefix` below.

### Build

From the project root in PowerShell, using your actual SDK and Node paths:

```powershell
.\scripts\build-plugin-windows.ps1 `
  -ObsSdkDir 'C:\obs-sdk-33.0.1-x64' `
  -DependencyPrefix 'C:\path\to\obs-dependencies' `
  -NodeExe 'C:\node-win-x64\node.exe' `
  -NodeLicense 'C:\node-win-x64\LICENSE'
```

The script checks the installed OBS version at `C:\Program Files\obs-studio\bin\64bit\obs64.exe`. Use `-ObsExe` for another location. It configures MSVC x64, builds Release, runs the native command-line quoting test, and packages the DLL, web service, Node runtime and licenses. Outputs:

- `dist/windows-x64/SkiRaceOverlay/` — complete installable folder.
- `dist/SkiRaceOverlay-windows-x64.zip` — archive of that folder.

CMake files and optional presets are in `native/`; the PowerShell script handles configuration from the project root. The macOS shell scripts remain separate.

### Install

Close OBS. From an **Administrator PowerShell**, run:

```powershell
.\scripts\install-plugin-windows.ps1
```

For an extracted package elsewhere, pass `-PackageDir 'C:\path\SkiRaceOverlay'`. The installer validates the package and installs it under `%ProgramData%\obs-studio\plugins\SkiRaceOverlay`, following the [OBS plugin directory layout](https://obsproject.com/kb/plugins-guide). Existing plugin files are backed up under the installing user's `%LOCALAPPDATA%\ski-stream-overlay\plugin-backups`; a failed copy restores the backup. Portable OBS installations need separate installation handling.

Start OBS and add a **Ski Race Overlay** source. Its properties open the control panel at `http://127.0.0.1:8787`. The plugin starts its bundled service; configuration, race state and `service.log` live under the OBS user's `%LOCALAPPDATA%\ski-stream-overlay`. The control panel stays bound to localhost. The package is not signed and does not include an installer for Microsoft runtime dependencies; verify these on the target machine before distribution.

### Platform implementation

`native/platform.hpp` selects Windows code with `_WIN32` and keeps the macOS implementation in the other branch. Windows uses Winsock, `CreateProcessW` with Unicode paths/environment, and `ShellExecuteW` for the browser. The plugin retains ownership of its child process and asks the service to shut down through a private stdin pipe before a bounded forced-stop fallback. It does not terminate a service that was already running. OBS browser-source creation and updates remain scheduled on the OBS UI thread.

### Verification before publishing a Windows package

Run the portable tests from the project root:

```powershell
node --test test/backend.test.mjs test/ui-state.test.mjs simulator/simulator.test.mjs
```

Then verify on Windows:

- OBS loads the plugin, starts the service once and opens the control panel. Both transparent overlays render and automatic view/category changes work.
- Unicode competitor names, paths containing spaces, CSV imports and settings persistence work.
- An unrelated service on port 8787 is untouched; a pre-existing overlay service remains running after OBS closes.
- Adding/removing/duplicating sources, switching scenes and closing OBS neither hang nor leave owned service processes behind. The current macOS lifecycle harness is not a Windows runtime test.
- The simulator's TCP feed, disconnect/reconnect and separate test/live results work, followed by a real VOLA test. For a remote timing PC, configure its address and timing-port firewall rule.

Keep the Windows build labelled **UNTESTED** until it has been compiled and these checks have passed on Windows. Record the tested OBS version and architecture before publishing it as supported.

## Publication check

`publication-files.json` lists the source files intended for publication. Local demo and event images, event wiring documents, race data, logs and build packages are excluded from the repository. Check files before publishing:

```bash
npm run check:publication
```

The check verifies that the Git index matches the publication manifest and scans source files for personal paths and common credential patterns. It does not replace a file review.

## Origin and licenses

Licensed under GPL-2.0-or-later. See [LICENSE](LICENSE).

The VOLA adapter is based on [Kiril's implementation](https://github.com/jovchev/vola-skialppro-text-overlay). Its `package.json` declares the ISC license; no separate LICENSE file was present when reviewed. The native component's GPL license text is in [native/COPYING](native/COPYING). Built packages also include the Node.js runtime's own LICENSE file.

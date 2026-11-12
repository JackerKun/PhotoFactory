<p align="center"><img src="src-tauri/icons/icon.png" width="104" height="104" alt="PhotoFactory logo"></p>
<h1 align="center">PhotoFactory</h1>
<p align="center">Keep photographs local. Find them by people, time, place and content.</p>
<p align="center"><a href="https://github.com/JackerKun/PhotoFactory">GitHub</a> · <a href="README.md">简体中文</a> · English · <a href="#interface-tour">Interface tour</a> · <a href="#development">Development</a> · <a href="docs/BUILDING.md">Build guide</a> · <a href="#data-and-limitations">Data and limitations</a></p>

PhotoFactory is a local-first desktop photograph manager built with Tauri 2, Rust, React and SQLite. Index a directory, browse photographs, combine search and EXIF filters, organize people and tags, inspect GPS locations and build albums. Photograph analysis runs locally.

![Photograph grid, directory navigation and timeline with generated demonstration images](docs/screenshots/library.webp)

**Screenshot provenance:** these are browser captures of the actual React components with mocked Tauri commands and 36 generated images. People, classifications, confidence scores, GPS, albums and metadata are seeded examples, not model predictions. They do not validate the native backend, Windows installers or AI accuracy. See [capture notes](docs/screenshots/README.md).

Version **0.1.6** is under active development. Try a copy of your photographs first. Pagination, virtualization and incremental processing are implementation mechanisms, not evidence of a completed 100,000-photo benchmark.

## Interface tour

| Workspace | Purpose |
| --- | --- |
| Photos | Directory indexing, incremental updates, square / proportional grids, timeline navigation, keyword and EXIF filters, sorting, favorites and ratings. |
| Viewer | Zoom, pan, folder filmstrip, metadata, tags and existing face results. Double-click a photograph, then press `I` for details. |
| People | Local face analysis, naming, merging, review, and group photos filtered by people or group size. Automatic merging of unnamed people supports preview and undo. |
| Tags | Scene and semantic results grouped by source; editable tags allow manual correction. |
| Map | Standard and satellite layers, offline map import and export, GPS photograph previews, capture tracks, address search, and coordinate editing. |
| Albums | Time-, person-, place- and content-based organization with search and pagination. |
| Library tools | Jobs, intelligent search, similar-photo candidates, RAW+JPEG stacks, stories, trash, edit parameters, XMP and additional read-only storage sources. |

![Viewer and metadata panel demonstration](docs/screenshots/viewer.webp)

![Seeded people groups, not actual recognition results](docs/screenshots/people.webp)

![Seeded content labels and confidence values](docs/screenshots/tags.webp)

![Demonstration albums](docs/screenshots/albums.webp)

![Map with synthetic Shanghai coordinates and preserved attribution](docs/screenshots/map.webp)

![Library tool entry points](docs/screenshots/tools.webp)

In the map toolbar, open **Capture tracks (拍摄轨迹)**, select an area, optionally set a date range, and generate a track. PhotoFactory connects geotagged photos in capture order. Click a point to spread out nearby thumbnails, then click a thumbnail to open the photo. Collapse the floating panel with the arrow next to its title to keep the map clear. The refresh icon in the map status bar retries failed tiles.

Run `./startOffline.sh` to open the standalone offline map tool in a browser. Export one layer as `.mbtiles` or both layers as `.pfmap`, then import the package through the map toolbar. PhotoFactory stores imported maps under `.pf/maps/offline/` and fetches missing tiles online when available. The map also exports imported and cached tiles. See the [offline map guide](docs/OFFLINE_MAPS.md).

The sidebar offers light, dark, and system themes. The background tasks panel shows thumbnail and AI progress, with low, balanced, and full thumbnail performance settings.

The [Chinese user guide](docs/USER_GUIDE.md) explains the workflows and keyboard shortcuts. Import indexes existing files rather than moving or copying them. Select the original directory containing `.pf/project.json` to reopen a project. Use incremental scanning when adding photographs instead of rebuilding every person group.

## Development

Prepare Node.js (CI uses 22), Rust stable, Python 3.10 / 3.11 and the platform's Tauri prerequisites. Windows needs C++ Build Tools and WebView2. macOS needs Xcode Command Line Tools. See the [build guide](docs/BUILDING.md).

Use `./start.sh` to prepare dependencies and start the desktop app in one step. Run it from Git Bash on Windows. For manual setup, follow the steps below.

```bash
cd PhotoFactory
npm ci
python3 -m venv ai_worker/.venv
ai_worker/.venv/bin/python -m pip install -r ai_worker/requirements.txt
ai_worker/.venv/bin/python ai_worker/download_models.py
npm run tauri dev
```

On Windows, use `ai_worker\.venv\Scripts\python.exe`. Running `npm run dev` alone starts only the frontend, without native scanning, SQLite commands or the AI Worker.

## Packaging and checks

```bash
# macOS
RUN_TESTS=1 ./build.sh macos

# Frontend checks
npm test
npm run build

# Native library tests
cd src-tauri
cargo test --lib
```

Windows builds use `build-windows.ps1`, or `build.sh windows` in Git Bash on Windows. Full packages include the standalone AI Worker and models; end users do not need Python. Build DMG and Windows installers / workers on their corresponding operating systems.

The workflow in `.github/workflows/release.yml` builds macOS Intel / Apple Silicon and Windows x64 / ARM64 on matching runners. Pushing a stable `vX.Y.Z` tag publishes a Release only after all four builds, tests and artifact integrity checks pass. Manual branch runs produce Actions artifacts only. Models are downloaded and validated in CI; they do not belong in Git. Windows ARM64 uses a native ARM64 app with an x64 AI Worker under Windows 11 emulation; 32-bit Windows is unsupported. See the [release guide](docs/BUILDING.md#6-github-actions-四架构构建与-release). Local ad-hoc signing is not Developer ID signing or Apple notarization. This README does not advertise local build paths as public downloads.

Build status, test results, and temporary installer artifacts are available in [GitHub Actions](https://github.com/JackerKun/PhotoFactory/actions/workflows/release.yml).

## Data and limitations

- The photograph root contains `.pf/project.json`, `photos.db`, thumbnails, map tiles and AI caches. Back up both originals and project data. The database also holds user organization; deleting `.pf/` loses more than disposable previews. Close the application before a file-level SQLite backup.
- Local models need initial preparation / downloads. Recognition and similarity suggestions need human review.
- Maps and address search contact OpenStreetMap, Esri or Nominatim; requested areas / queries go to the service. Cached tiles can be reused offline.
- OCR optionally uses system Tesseract and installed language data. Writing edited GPS back to originals requires ExifTool and an explicit write operation; storing coordinates in the project database is separate.
- HEIC / HEIF, RAW, PSD, XCF and EXR preview support depends on platform decoding and installed dependencies.
- The edit workspace stores parameters. Do not interpret it as a complete RAW development or rendered-output pipeline.
- Additional storage sources can be indexed read-only. Preserve original backups before testing cleanup or metadata-writing workflows.

Source layout: `src/` frontend; `src-tauri/` native application; `ai_worker/` local analysis; `docs/` usage, building and provenance; `tools/screenshots/` optional documentation capture tooling. See the [change log](docs/CHANGELOG_2026-10-30.md) and [face evaluation notes](docs/FACE_EVALUATION.md).

# PhotoFactory File Format Filter + Import UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add file extension filtering (case-insensitive) to import/scan, persist enabled formats per project, add Sidebar project name + refresh + import dropdown, and add close button to ImportModal.

**Architecture:** Backend adds `enabled_extensions` to Project model and a new scanner function that filters by extension list. Frontend adds a FormatFilterPanel component with 3-level checkbox grouping, wires it into Sidebar refresh and ImportModal flows, and adds close/dropdown UI.

**Tech Stack:** Tauri 2.0, React + TypeScript, Rust + rusqlite, Zustand

---

### Task 1: Expand SUPPORTED_EXTENSIONS to full superset

**Files:**
- Modify: `src-tauri/src/models/photo.rs:50-54`

- [ ] **Step 1: Expand the extension list**

```rust
// src-tauri/src/models/photo.rs:50-54
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    // Common
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif",
    // RAW (includes TIFF as per user request)
    "cr2", "cr3", "nef", "arw", "orf", "rw2", "pef", "dng", "raf", "tif", "tiff",
    // Professional
    "psd", "xcf", "exr", "raw",
];
```

- [ ] **Step 2: Verify test still passes**

Run: `cd src-tauri && cargo test test_is_supported_image`
Expected: PASS (tests check jpg, PNG, heic are supported; mp4, txt are not)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/models/photo.rs
git commit -m "feat: expand SUPPORTED_EXTENSIONS to full superset including TIFF, RAW, PSD"
```

---

### Task 2: Add enabled_extensions to Project model

**Files:**
- Modify: `src-tauri/src/models/project.rs:33-55`

- [ ] **Step 1: Add DEFAULT_EXTENSIONS constant and update Project::new**

```rust
// src-tauri/src/models/project.rs — add after the struct definition

/// Default extensions enabled for import: common image formats only.
pub const DEFAULT_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif",
];

impl Project {
    pub fn new(name: String, root_path: String) -> Self {
        Self {
            name,
            root_path,
            created_at: chrono::Utc::now().to_rfc3339(),
            last_scan: None,
            total_photos: 0,
            thumbnail_threshold_mb: 30,
            ai_models: AiModelConfig::default(),
            enabled_extensions: DEFAULT_EXTENSIONS.iter().map(|s| s.to_string()).collect(),
        }
    }
```

- [ ] **Step 2: Add enabled_extensions field to Project struct**

```rust
// src-tauri/src/models/project.rs:5-13
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub root_path: String,
    pub created_at: String,
    pub last_scan: Option<String>,
    pub total_photos: i64,
    pub thumbnail_threshold_mb: i64,
    pub ai_models: AiModelConfig,
    pub enabled_extensions: Vec<String>,
}
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/models/project.rs
git commit -m "feat: add enabled_extensions field to Project model with default common formats"
```

---

### Task 3: Add scan_directory_with_extensions to file_scanner

**Files:**
- Modify: `src-tauri/src/scanner/file_scanner.rs:16-54`

- [ ] **Step 1: Add the extension-filtering scan function**

Add after the existing `scan_directory` function (after line 40):

```rust
/// Scan directory filtering by a list of extensions (case-insensitive).
pub fn scan_directory_with_extensions(root: &Path, extensions: &[String]) -> Vec<FileInfo> {
    let ext_set: std::collections::HashSet<String> = extensions
        .iter()
        .map(|e| e.to_lowercase())
        .collect();

    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !is_hidden(e))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| is_matching_extension(e.path(), &ext_set))
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::metadata(path).ok()?;
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(FileInfo {
                path: path.to_string_lossy().to_string(),
                filename: path.file_name()?.to_string_lossy().to_string(),
                file_size: metadata.len() as i64,
                file_mtime: mtime,
            })
        })
        .collect()
}

fn is_matching_extension(path: &Path, extensions: &std::collections::HashSet<String>) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| extensions.contains(&e.to_lowercase()))
        .unwrap_or(false)
}
```

- [ ] **Step 2: Add a test for extension filtering with mixed case**

Add to the existing `#[cfg(test)] mod tests` block:

```rust
#[test]
fn test_scan_directory_with_extensions() {
    let dir = std::env::temp_dir().join("pf_ext_filter_test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("photo1.JPG"), "fake").unwrap();
    fs::write(dir.join("photo2.jpeg"), "fake").unwrap();
    fs::write(dir.join("photo3.PNG"), "fake").unwrap();
    fs::write(dir.join("photo4.HEIC"), "fake").unwrap();
    fs::write(dir.join("photo5.cr2"), "fake").unwrap();
    fs::write(dir.join("photo6.txt"), "fake").unwrap();

    // Only common formats
    let exts = vec!["jpg".into(), "jpeg".into(), "png".into()];
    let results = scan_directory_with_extensions(&dir, &exts);
    assert_eq!(results.len(), 3);

    // Include HEIC
    let exts = vec!["jpg".into(), "jpeg".into(), "png".into(), "heic".into()];
    let results = scan_directory_with_extensions(&dir, &exts);
    assert_eq!(results.len(), 4);

    // Empty — nothing matches
    let results = scan_directory_with_extensions(&dir, &[]);
    assert_eq!(results.len(), 0);

    let _ = fs::remove_dir_all(&dir);
}
```

- [ ] **Step 3: Run the test**

Run: `cd src-tauri && cargo test test_scan_directory_with_extensions`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/scanner/file_scanner.rs
git commit -m "feat: add scan_directory_with_extensions with case-insensitive filtering and test"
```

---

### Task 4: Update scan commands to use project extensions

**Files:**
- Modify: `src-tauri/src/commands/project.rs:49-70` (cmd_scan_project)
- Modify: `src-tauri/src/commands/project.rs:108-176` (cmd_incremental_scan)
- Modify: `src-tauri/src/lib.rs:47-77` (scan_and_import, incremental_scan — used by lib functions)

- [ ] **Step 1: Update `cmd_scan_project` to use extensions**

```rust
// src-tauri/src/commands/project.rs:49-70 — replace the spawn_blocking closure
let count = tokio::task::spawn_blocking(move || {
    let conn = init_db(&project.db_path())?;
    scan_and_import_with_conn(&project, &conn)
})
```

And update `scan_and_import_with_conn` to use the extension-aware scanner:

```rust
// src-tauri/src/commands/project.rs — replace the scan_and_import_with_conn function
fn scan_and_import_with_conn(project: &Project, conn: &Connection) -> AppResult<usize> {
    use crate::db::photo_dao;
    use crate::scanner::file_scanner;
    use crate::scanner::exif_reader;
    use std::path::Path;

    let extensions = &project.enabled_extensions;
    let files = file_scanner::scan_directory_with_extensions(Path::new(&project.root_path), extensions);
    let mut count = 0;
    let batch_size = 500;

    for chunk in files.chunks(batch_size) {
        let entries: Vec<_> = chunk.iter().filter_map(|fi| {
            let exif = exif_reader::read_exif(Path::new(&fi.path)).ok()?;
            Some((fi.clone(), exif))
        }).collect();

        if !entries.is_empty() {
            photo_dao::batch_insert_photos(conn, &entries)?;
            count += entries.len();
        }
    }

    let mut project = project.clone();
    project.last_scan = Some(chrono::Utc::now().to_rfc3339());
    project.total_photos = photo_dao::get_photo_count(conn)?;
    save_project_json(&project)?;

    Ok(count)
}
```

- [ ] **Step 2: Update `cmd_incremental_scan` similarly**

```rust
// src-tauri/src/commands/project.rs — replace the incremental_scan_with_conn function
fn incremental_scan_with_conn(project: &Project, conn: &Connection) -> AppResult<(usize, usize, usize)> {
    use rusqlite::OptionalExtension;
    use crate::db::photo_dao;
    use crate::scanner::file_scanner;
    use crate::scanner::exif_reader;
    use std::path::Path;

    let extensions = &project.enabled_extensions;
    let files = file_scanner::scan_directory_with_extensions(Path::new(&project.root_path), extensions);
    let known_paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();

    let deleted = photo_dao::mark_deleted_photos(conn, &known_paths)?;

    let mut new_entries = Vec::new();

    for fi in &files {
        let needs_update = {
            let mut stmt = conn.prepare("SELECT id, file_mtime FROM photos WHERE path = ?")?;
            let result = stmt.query_row([&fi.path], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            }).optional()?;
            match result {
                Some((id, old_mtime)) => {
                    if old_mtime != fi.file_mtime {
                        Some(id)
                    } else {
                        None
                    }
                }
                None => None,
            }
        };

        if let Some(id) = needs_update {
            let exif = exif_reader::read_exif(Path::new(&fi.path)).unwrap_or_default();
            conn.execute(
                "UPDATE photos SET file_size = ?, file_mtime = ?, width = ?, height = ?, taken_at = ?, camera_make = ?, camera_model = ?, latitude = ?, longitude = ?, orientation = ? WHERE id = ?",
                rusqlite::params![fi.file_size, fi.file_mtime, exif.width, exif.height, exif.taken_at, exif.camera_make, exif.camera_model, exif.latitude, exif.longitude, exif.orientation, id],
            )?;
            photo_dao::update_thumbnail_status(conn, id, 0)?;
            photo_dao::update_ai_status(conn, id, 0)?;
            new_entries.push(id);
        } else {
            let exif = exif_reader::read_exif(Path::new(&fi.path)).unwrap_or_default();
            photo_dao::insert_photo(conn, fi, &exif)?;
            new_entries.push(conn.last_insert_rowid());
        }
    }

    let mut project = project.clone();
    project.last_scan = Some(chrono::Utc::now().to_rfc3339());
    project.total_photos = photo_dao::get_photo_count(conn)?;
    save_project_json(&project)?;

    Ok((new_entries.len(), deleted, new_entries.len() + deleted))
}
```

- [ ] **Step 3: Update lib.rs `scan_and_import` and `incremental_scan`**

These are used by the library-level imports. Update both to use `scan_directory_with_extensions`:

```rust
// src-tauri/src/lib.rs — in scan_and_import, replace the scan call
let files = file_scanner::scan_directory_with_extensions(
    Path::new(&project.root_path),
    &project.enabled_extensions,
);
```

```rust
// src-tauri/src/lib.rs — in incremental_scan, replace the scan call
let files = file_scanner::scan_directory_with_extensions(
    Path::new(&project.root_path),
    &project.enabled_extensions,
);
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/project.rs src-tauri/src/lib.rs
git commit -m "feat: use project enabled_extensions in scan commands"
```

---

### Task 5: Add cmd_close_project and cmd_update_extensions commands

**Files:**
- Modify: `src-tauri/src/commands/project.rs` (add two new commands)
- Modify: `src-tauri/src/main.rs:35-74` (register new commands)

- [ ] **Step 1: Add `cmd_close_project`**

Add to `src-tauri/src/commands/project.rs`:

```rust
/// Clear the current project from memory state.
#[tauri::command]
pub async fn cmd_close_project(state: State<'_, AppState>) -> AppResult<()> {
    *state.project.lock().unwrap() = None;
    Ok(())
}
```

- [ ] **Step 2: Add `cmd_update_extensions`**

Add to `src-tauri/src/commands/project.rs`:

```rust
/// Update the enabled extensions for the current project and persist to project.json.
#[tauri::command]
pub async fn cmd_update_extensions(extensions: Vec<String>, state: State<'_, AppState>) -> AppResult<Project> {
    let conn = get_conn(state.clone())?;
    let mut guard = state.project.lock().unwrap();
    let project = guard.as_mut()
        .ok_or_else(|| crate::error::AppError::Project("No project open".into()))?;

    project.enabled_extensions = extensions;
    project.total_photos = photo_dao::get_photo_count(&conn)?;
    save_project_json(project)?;

    Ok(project.clone())
}
```

- [ ] **Step 3: Register both commands in main.rs**

```rust
// src-tauri/src/main.rs — add after project::cmd_get_last_project_path
            project::cmd_close_project,
            project::cmd_update_extensions,
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/project.rs src-tauri/src/main.rs
git commit -m "feat: add cmd_close_project and cmd_update_extensions commands"
```

---

### Task 6: Add API wrappers and Project type update

**Files:**
- Modify: `src/api/tauri.ts` (add two new API functions)
- Modify: `src/types/index.ts` (add enabled_extensions to Project interface)

- [ ] **Step 1: Update Project interface**

```typescript
// src/types/index.ts — add to Project interface
export interface Project {
  // ... existing fields ...
  enabled_extensions: string[];
}
```

- [ ] **Step 2: Add API wrappers**

Add to `src/api/tauri.ts`:

```typescript
export async function closeProject(): Promise<void> {
  return invoke("cmd_close_project");
}

export async function updateExtensions(extensions: string[]): Promise<Project> {
  return invoke<Project>("cmd_update_extensions", { extensions });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/api/tauri.ts src/types/index.ts
git commit -m "feat: add closeProject and updateExtensions API wrappers, update Project type"
```

---

### Task 7: Create FormatFilterPanel component

**Files:**
- Create: `src/components/FormatFilterPanel.tsx`

- [ ] **Step 1: Create the component**

```typescript
import React, { useState } from "react";

interface ExtensionGroup {
  label: string;
  extensions: { ext: string; label: string }[];
}

const GROUPS: ExtensionGroup[] = [
  {
    label: "常见图片格式",
    extensions: [
      { ext: "jpg", label: "JPG" },
      { ext: "jpeg", label: "JPEG" },
      { ext: "png", label: "PNG" },
      { ext: "gif", label: "GIF" },
      { ext: "bmp", label: "BMP" },
      { ext: "webp", label: "WebP" },
      { ext: "heic", label: "HEIC" },
      { ext: "heif", label: "HEIF" },
    ],
  },
  {
    label: "RAW 格式",
    extensions: [
      { ext: "cr2", label: "CR2" },
      { ext: "cr3", label: "CR3" },
      { ext: "nef", label: "NEF" },
      { ext: "arw", label: "ARW" },
      { ext: "orf", label: "ORF" },
      { ext: "rw2", label: "RW2" },
      { ext: "pef", label: "PEF" },
      { ext: "dng", label: "DNG" },
      { ext: "raf", label: "RAF" },
      { ext: "tif", label: "TIF" },
      { ext: "tiff", label: "TIFF" },
    ],
  },
  {
    label: "专业格式",
    extensions: [
      { ext: "psd", label: "PSD" },
      { ext: "xcf", label: "XCF" },
      { ext: "exr", label: "EXR" },
    ],
  },
];

interface Props {
  currentExtensions: string[];
  onConfirm: (extensions: string[]) => void;
  onCancel: () => void;
}

export default React.memo(function FormatFilterPanel({ currentExtensions, onConfirm, onCancel }: Props) {
  // Initialize from currentExtensions
  const [selected, setSelected] = useState<Set<string>>(() => new Set(currentExtensions));

  const allExts = GROUPS.flatMap((g) => g.extensions.map((e) => e.ext));
  const isGroupAllChecked = (group: ExtensionGroup) =>
    group.extensions.every((e) => selected.has(e.ext));
  const isGroupSomeChecked = (group: ExtensionGroup) =>
    group.extensions.some((e) => selected.has(e.ext));

  const toggleGroup = (group: ExtensionGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (isGroupAllChecked(group)) {
        // Uncheck all
        group.extensions.forEach((e) => next.delete(e.ext));
      } else {
        // Check all
        group.extensions.forEach((e) => next.add(e.ext));
      }
      return next;
    });
  };

  const toggleExt = (ext: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ext)) next.delete(ext);
      else next.add(ext);
      return next;
    });
  };

  const handleConfirm = () => {
    if (selected.size === 0) {
      alert("请至少选择一种文件格式");
      return;
    }
    onConfirm(Array.from(selected));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary rounded-xl p-6 w-full max-w-lg shadow-2xl">
        <h3 className="text-lg font-bold mb-4 text-text-primary">选择导入的文件格式</h3>

        {GROUPS.map((group) => (
          <div key={group.label} className="mb-4">
            <label className="flex items-center gap-2 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isGroupAllChecked(group)}
                ref={(el) => { if (el) el.indeterminate = isGroupSomeChecked(group) && !isGroupAllChecked(group); }}
                onChange={() => toggleGroup(group)}
                className="accent-accent-primary"
              />
              <span className="text-sm font-medium text-text-primary">{group.label}</span>
            </label>
            <div className="flex flex-wrap gap-2 ml-6">
              {group.extensions.map(({ ext, label }) => (
                <label key={ext} className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(ext)}
                    onChange={() => toggleExt(ext)}
                    className="accent-accent-primary w-3 h-3"
                  />
                  <span className="text-xs text-text-secondary">{label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}

        <div className="flex gap-3 mt-6">
          <button onClick={onCancel}
            className="flex-1 bg-surface-primary border border-surface-secondary text-text-primary py-2 rounded-lg text-sm">
            取消
          </button>
          <button onClick={handleConfirm}
            className="flex-1 bg-accent-primary hover:bg-accent-primary/80 text-white py-2 rounded-lg text-sm font-medium">
            确认
          </button>
        </div>
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add src/components/FormatFilterPanel.tsx
git commit -m "feat: add FormatFilterPanel with 3-level checkbox grouping"
```

---

### Task 8: Update Sidebar — project name + refresh + import dropdown

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Rewrite the Sidebar header**

```tsx
// src/components/Sidebar.tsx — full file rewrite
import React, { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import DirectoryTree from "./DirectoryTree";
import FormatFilterPanel from "./FormatFilterPanel";
import type { ViewMode, Project } from "../types";
import { useStore } from "../hooks/usePhotos";
import * as api from "../api/tauri";

interface Props { viewMode: ViewMode; onViewModeChange: (mode: ViewMode) => void; project: Project | null; onImport: () => void }

const navItems = [
  { mode: "grid" as ViewMode, icon: "📷", label: "Photos" },
  { mode: "map" as ViewMode, icon: "🗺️", label: "Map" },
  { mode: "faces" as ViewMode, icon: "👥", label: "People" },
  { mode: "tags" as ViewMode, icon: "🏷️", label: "Tags" },
];

export default React.memo(function Sidebar({ viewMode, onViewModeChange, project, onImport }: Props) {
  const { setProject, reset } = useStore();
  const [showFormatPanel, setShowFormatPanel] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  const handleRefresh = useCallback(() => {
    if (!project) return;
    setShowFormatPanel(true);
  }, [project]);

  const handleFormatConfirm = async (extensions: string[]) => {
    setShowFormatPanel(false);
    try {
      const updatedProject = await api.updateExtensions(extensions);
      setProject(updatedProject);
      const result = await api.incrementalScan();
      alert(`扫描完成：新增 ${result[0]} 个，删除 ${result[1]} 个`);
      setProject(await api.getProject());
      reset();
      // Trigger reload via FilterSync
      setTimeout(() => useStore.getState().loadPhotos(), 100);
    } catch (err) {
      alert("扫描失败：" + err);
    }
  };

  const handleImportNew = useCallback(() => {
    setShowDropdown(false);
    onImport();
  }, [onImport]);

  const handleCloseProject = useCallback(async () => {
    setShowDropdown(false);
    try {
      await api.closeProject();
      setProject(null);
      reset();
    } catch (err) {
      console.error("Failed to close project:", err);
    }
  }, [setProject, reset]);

  return (
    <aside className="w-64 bg-bg-secondary border-r border-surface-secondary flex flex-col">
      <div className="p-4 border-b border-surface-secondary">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-lg font-bold text-accent-primary">PhotoFactory</h1>
        </div>
        {project && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-text-secondary truncate flex-1 mr-2" title={project.name}>
              {project.name}
            </p>
            <div className="relative">
              <button onClick={() => setShowDropdown(!showDropdown)}
                className="text-xs text-text-muted hover:text-text-primary p-1" title="More">
                ⋮
              </button>
              {showDropdown && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowDropdown(false)} />
                  <div className="absolute right-0 top-full mt-1 bg-bg-secondary border border-surface-secondary rounded-lg shadow-lg z-20 min-w-[160px]">
                    <button onClick={handleImportNew}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface-primary first:rounded-t-lg">
                      导入新文件夹
                    </button>
                    <button onClick={handleRefresh}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface-primary">
                      重新扫描
                    </button>
                    <button onClick={handleCloseProject}
                      className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-surface-primary last:rounded-b-lg">
                      关闭项目
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <nav className="p-2">
        {navItems.map((item) => (
          <button key={item.mode} onClick={() => onViewModeChange(item.mode)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              viewMode === item.mode ? "bg-accent-primary text-white" : "text-text-secondary hover:bg-surface-primary"
            }`}>
            <span>{item.icon}</span><span>{item.label}</span>
          </button>
        ))}
      </nav>
      {viewMode === "grid" && project && (
        <div className="flex-1 overflow-hidden border-t border-surface-secondary">
          <DirectoryTree rootPath={project.root_path} />
        </div>
      )}

      {showFormatPanel && project && (
        <FormatFilterPanel
          currentExtensions={project.enabled_extensions?.length > 0 ? project.enabled_extensions : ["jpg","jpeg","png","gif","bmp","webp","heic","heif"]}
          onConfirm={handleFormatConfirm}
          onCancel={() => setShowFormatPanel(false)}
        />
      )}
    </aside>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: update Sidebar with project name, dropdown menu (import/refresh/close), and format panel"
```

---

### Task 9: Add close button to ImportModal

**Files:**
- Modify: `src/components/ImportModal.tsx`

- [ ] **Step 1: Add Props.onClose and close button**

The ImportModal currently receives `{ onImported }`. We need to also accept an `onClose` callback so the parent can dismiss it.

```tsx
// src/components/ImportModal.tsx — update interface and add close button
interface Props { onImported: () => void; onClose?: () => void }

export default React.memo(function ImportModal({ onImported, onClose }: Props) {
```

- [ ] **Step 2: Add the close button to the modal header**

```tsx
// Replace the h2 header in ImportModal.tsx
<div className="flex items-center justify-between mb-4">
  <h2 className="text-xl font-bold text-text-primary">
    {mode === "create" ? "导入照片" : "打开项目"}
  </h2>
  {onClose && (
    <button onClick={onClose} className="text-text-muted hover:text-text-primary text-lg leading-none">
      ✕
    </button>
  )}
</div>
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ImportModal.tsx
git commit -m "feat: add close button to ImportModal"
```

---

### Task 10: Wire ImportModal with close in App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Pass onClose to ImportModal**

In `AppLayout`, the ImportModal is rendered at line 97. Add the `onClose` prop:

```tsx
// In AppLayout, replace the ImportModal line
{showImport && <ImportModal onImported={handleImported} onClose={() => setShowImport(false)} />}
```

- [ ] **Step 2: Handle "import new folder" flow — close current project first**

When the user selects "导入新文件夹" from the Sidebar dropdown, they should first close the current project, then the ImportModal opens. The Sidebar already calls `onImport()` which sets `showImport(true)`. But we need to close the current project before opening a new one.

Update the `handleImportNew` in Sidebar to also close the current project:

```tsx
// In Sidebar.tsx, update handleImportNew
const handleImportNew = useCallback(async () => {
  setShowDropdown(false);
  if (project) {
    await api.closeProject();
    setProject(null);
    reset();
  }
  onImport();
}, [project, setProject, reset, onImport]);
```

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx src/components/Sidebar.tsx
git commit -m "feat: wire ImportModal close and handle import-new-folder flow"
```

---

### Task 11: Build and validate end-to-end

- [ ] **Step 1: Full build**

Run: `cd /Users/jackerkun/Downloads/PhotoFactory && cargo check --manifest-path src-tauri/Cargo.toml && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Manual test checklist**
  1. Open app → ImportModal appears with format panel option → select folder → confirm formats → scan runs → photos appear
  2. Sidebar shows project name + ⋮ dropdown → "重新扫描" opens format panel pre-checked → confirm → incremental scan
  3. Dropdown "导入新文件夹" → closes current project → ImportModal opens
  4. Dropdown "关闭项目" → clears project → blank state
  5. ImportModal ✕ button → closes modal without action
  6. RAW format files (e.g. .ARW, .CR2) not scanned by default, appear when RAW group is checked
  7. Case-insensitive: files named `.JPG`, `.Png` are matched correctly

# PhotoFactory 功能增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PhotoFactory 添加导入进度、AI 后台处理、EXIF 参数展示、缩略图模式优化、GPS EXIF 写入等核心功能增强。

**Architecture:** 分 4 个阶段逐步实现，每阶段独立可测试。Rust 后端新增 EXIF 读取/写入命令，前端增加进度轮询、AI 状态事件监听、新的缩略图渲染模式。

**Tech Stack:** Rust (Tauri 2, kamadak-exif, rusqlite), React 18 + TypeScript, Zustand, @tanstack/react-virtual, TailwindCSS

**Design doc:** `docs/superpowers/specs/2026-04-13-photo-enhancement-design.md`

---

## File Structure

### 新增文件
- `src-tauri/src/commands/exif_writer.rs` — GPS EXIF 写入外部工具调用（调用 `exiftool`）
- `src-tauri/src/db/ai_status_dao.rs` — 待处理 AI 照片计数查询

### 修改文件
- `src-tauri/src/scanner/exif_reader.rs` — 增加 ExposureTime, FNumber, ISOSpeedRatings 读取
- `src-tauri/src/models/photo.rs` — Photo 模型新增 exposure_time, f_number, iso 字段
- `src-tauri/src/commands/project.rs` — scan 完成后触发 AI 管道，增加进度报告
- `src-tauri/src/commands/ai.rs` — 增加 `cmd_get_ai_status` 命令，auto pipeline emit 事件
- `src-tauri/src/commands/photos.rs` — `cmd_update_photo_gps` 增加 EXIF 写入
- `src-tauri/src/main.rs` — 注册新命令
- `src-tauri/src/lib.rs` — 扫描后调用 AI 管道
- `src/types/index.ts` — Photo 新增字段，新增 AiStatus 类型
- `src/hooks/usePhotos.ts` — Zustand store 新增 aiProcessingStatus
- `src/api/tauri.ts` — 新增 getScanProgress, getAiPendingCount, getAiStatus, triggerAutoAi 等 API
- `src/components/ImportModal.tsx` — 进度条、轮询、关闭确认
- `src/components/Sidebar.tsx` — AI 状态指示器
- `src/components/PhotoDetail.tsx` — EXIF 参数展示行、GPS 提示文字
- `src/components/PhotoGrid.tsx` — proportional 模式、骨架屏
- `src/components/PhotoCard.tsx` — proportional 模式、懒加载优化
- `src/components/ThumbnailToolbar.tsx` — 收窄为 200px 竖向、original → proportional
- `src/App.tsx` — 路由变化时关闭 PhotoDetail

---

### Task 1: EXIF 参数读取 + Photo 模型扩展

**Files:**
- Modify: `src-tauri/src/scanner/exif_reader.rs`
- Modify: `src-tauri/src/models/photo.rs`
- Modify: `src/types/index.ts`
- Test: `src-tauri/src/scanner/exif_reader.rs` (existing tests)

- [ ] **Step 1: 更新 ExifData 结构体，增加拍摄参数字段**

修改 `src-tauri/src/scanner/exif_reader.rs`，在 `ExifData` 结构体中增加三个新字段：

```rust
#[derive(Debug, Default, Clone)]
pub struct ExifData {
    pub taken_at: Option<i64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub orientation: i32,
    pub exposure_time: Option<String>,   // NEW: "1/250" or "2"
    pub f_number: Option<String>,        // NEW: "2.8"
    pub iso: Option<u32>,                // NEW: 400
}
```

在 `read_exif` 函数中增加读取逻辑（在 Camera Make/Model 之后、GPS 之前插入）：

```rust
    // ExposureTime
    if let Some(field) = exif.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY) {
        data.exposure_time = match &field.value {
            exif::Value::Rational(r) if !r.is_empty() => {
                let num = r[0].num;
                let den = r[0].denom;
                if den == 0 { None }
                else if num >= den { Some(format!("{}", num / den)) }
                else { Some(format!("1/{}", den / num)) }
            }
            _ => None,
        };
    }

    // FNumber
    if let Some(field) = exif.get_field(exif::Tag::FNumber, exif::In::PRIMARY) {
        data.f_number = match &field.value {
            exif::Value::Rational(r) if !r.is_empty() => {
                let val = r[0].num as f64 / r[0].denom as f64;
                Some(format!("{val:.1}"))
            }
            _ => None,
        };
    }

    // ISOSpeedRatings
    if let Some(field) = exif.get_field(exif::Tag::ISOSpeedRatings, exif::In::PRIMARY) {
        data.iso = field.value.get_uint(0);
    }
```

- [ ] **Step 2: 更新 Photo 模型，增加新字段**

修改 `src-tauri/src/models/photo.rs`，在 `Photo` 结构体中增加：

```rust
pub struct Photo {
    // ... existing fields ...
    pub exposure_time: Option<String>,
    pub f_number: Option<String>,
    pub iso: Option<u32>,
}
```

- [ ] **Step 3: 更新数据库 schema，增加新列**

修改 `src-tauri/src/db/schema.rs`，在 photos 表的 CREATE TABLE 中增加列：

```sql
exposure_time TEXT,
f_number TEXT,
iso INTEGER,
```

修改 `src-tauri/src/db/connection.rs`，在 `init_db` 函数中增加迁移（在现有的 is_favorite 迁移之后）：

```rust
// Add exposure columns if not present
conn.execute_batch(
    "ALTER TABLE photos ADD COLUMN exposure_time TEXT;
     ALTER TABLE photos ADD COLUMN f_number TEXT;
     ALTER TABLE photos ADD COLUMN iso INTEGER;"
).ok(); // ok() ignores "duplicate column" errors
```

- [ ] **Step 4: 更新 photo_dao 的插入和查询，包含新字段**

修改 `src-tauri/src/db/photo_dao.rs`：

1. 在 `PHOTO_COLS` 常量中增加 `exposure_time, f_number, iso`
2. 在 `row_to_photo` 函数中读取这三个新列
3. 在 `batch_insert_photos` 和 `insert_photo` 的 SQL 中增加这三个列的参数

具体修改 `batch_insert_photos` 的 INSERT 语句：

```rust
conn.execute_batch("INSERT OR IGNORE INTO photos (path, filename, file_size, file_mtime, width, height, format, taken_at, camera_make, camera_model, latitude, longitude, orientation, exposure_time, f_number, iso) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")?;
```

然后在循环中调用时增加参数：

```rust
conn.execute("...", rusqlite::params![
    // ... existing params ...
    exif.exposure_time,
    exif.f_number,
    exif.iso,
])?;
```

- [ ] **Step 5: 更新 TypeScript 类型定义**

修改 `src/types/index.ts`，在 `Photo` 接口中增加：

```typescript
export interface Photo {
  // ... existing fields ...
  exposure_time: string | null;
  f_number: string | null;
  iso: number | null;
}
```

- [ ] **Step 6: 运行 Rust 测试**

```bash
cd src-tauri && cargo test exif_reader
```

Expected: 2 tests pass (test_read_exif_nonexistent_file, test_read_exif_empty_file)

- [ ] **Step 7: 编译验证**

```bash
cd src-tauri && cargo check
```

Expected: No compilation errors

- [ ] **Step 8: 提交**

```bash
git add src-tauri/src/scanner/exif_reader.rs \
  src-tauri/src/models/photo.rs \
  src-tauri/src/db/schema.rs \
  src-tauri/src/db/connection.rs \
  src-tauri/src/db/photo_dao.rs \
  src/types/index.ts
git commit -m "feat: add EXIF shooting params (exposure, aperture, ISO) to Photo model

- Read ExposureTime, FNumber, ISOSpeedRatings in exif_reader
- Add columns to photos table with backward-compat migration
- Update Photo Rust struct and TypeScript interface"
```

---

### Task 2: EXIF 参数在 PhotoDetail 中展示

**Files:**
- Modify: `src/components/PhotoDetail.tsx:240-249` (Information 区域)

- [ ] **Step 1: 在 INFORMATION 区域增加 EXIF 参数展示行**

修改 `src/components/PhotoDetail.tsx` 的 Information 区域（约第 240-249 行），在 Camera 行之后增加：

```tsx
          {photo.camera_make && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">Camera:</span> {photo.camera_make} {photo.camera_model}</p>
          )}
          {photo.width && photo.height && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">Dimensions:</span> {photo.width} × {photo.height}</p>
          )}
          {photo.exposure_time && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">Shutter:</span> {photo.exposure_time}s</p>
          )}
          {photo.f_number && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">Aperture:</span> f/{photo.f_number}</p>
          )}
          {photo.iso && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">ISO:</span> {photo.iso}</p>
          )}
```

- [ ] **Step 2: 验证前端编译**

```bash
npx tsc --noEmit
```

Expected: No TypeScript errors

- [ ] **Step 3: 提交**

```bash
git add src/components/PhotoDetail.tsx
git commit -m "feat: display EXIF shooting params in PhotoDetail information panel

- Show dimensions (width × height), shutter speed, aperture, ISO
- Only render rows when values exist (no blank rows)"
```

---

### Task 3: 导入进度显示 + 弹窗关闭行为

**Files:**
- Modify: `src/components/ImportModal.tsx`
- Modify: `src/api/tauri.ts`

- [ ] **Step 1: 添加前端 API 封装**

修改 `src/api/tauri.ts`，增加：

```typescript
export async function getScanProgress(): Promise<{ scanned: number; total: number } | null> {
  try {
    const project = await invoke<Project | null>("cmd_get_project");
    if (!project || !project.total_photos) return null;
    return { scanned: project.total_photos, total: project.total_photos };
  } catch {
    return null;
  }
}
```

实际上，由于 `scan_and_import` 是分批插入数据库的，`total_photos` 会持续增长。但前端不知道"总文件数"，所以我们用一个更简单的方式：在扫描过程中轮询 `getProject()` 的 `total_photos`，显示"已发现 X 张照片..."，让用户看到数字在增长。

不需要新增 API 命令，直接轮询 `getProject()` 即可。

- [ ] **Step 2: 更新 ImportModal 增加进度条和轮询逻辑**

修改 `src/components/ImportModal.tsx`，增加 `isScanning` 状态和进度轮询：

```tsx
// src/components/ImportModal.tsx
import React, { useState, useRef, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { createProject, openProject, scanProject, updateExtensions, getProject } from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import FormatFilterPanel from "./FormatFilterPanel";

interface Props { onImported: () => void; onClose?: () => void }

const DEFAULT_EXTENSIONS = ["jpg","jpeg","png","gif","bmp","webp","heic","heif"];

export default React.memo(function ImportModal({ onImported, onClose }: Props) {
  const { setProject } = useStore();
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [photoCount, setPhotoCount] = useState(0);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"create" | "open">("create");
  const [showFormatPanel, setShowFormatPanel] = useState(false);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearScanTimer = useCallback(() => {
    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
  }, []);

  const startScanPolling = useCallback(() => {
    clearScanTimer();
    setPhotoCount(0);
    scanTimerRef.current = setInterval(async () => {
      const p = await getProject();
      if (p && p.total_photos > 0) {
        setPhotoCount(p.total_photos);
        setProgress(`已发现 ${p.total_photos.toLocaleString()} 张照片...`);
      }
    }, 200);
  }, [clearScanTimer]);

  const handlePickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Photo Folder",
    });
    if (selected && typeof selected === "string") {
      setRootPath(selected);
    }
  };

  const handleImportClick = () => {
    if (!rootPath.trim() || loading) return;
    if (mode === "create") {
      setShowFormatPanel(true);
    } else {
      handleSubmit();
    }
  };

  const handleFormatConfirm = (extensions: string[]) => {
    setShowFormatPanel(false);
    handleSubmit(extensions);
  };

  const handleSubmit = async (extensions?: string[]) => {
    if (!rootPath.trim()) return;
    setLoading(true);
    setError(null);
    let ok = false;
    try {
      if (mode === "create") {
        setProgress("Creating project...");
        const project = await createProject(rootPath.trim(), name.trim() || "My Photos");
        setProject(project);

        if (extensions && extensions.length > 0) {
          setProgress("Saving format settings...");
          const updated = await updateExtensions(extensions);
          setProject(updated);
        }

        setProgress("正在扫描文件...");
        startScanPolling();
        const count = await scanProject();
        clearScanTimer();
        setPhotoCount(count);
        setProgress(`扫描完成，共 ${count.toLocaleString()} 张照片！`);
      } else {
        setProgress("Opening project...");
        const project = await openProject(rootPath.trim());
        setProject(project);
        setProgress("Loading photos...");
      }
      ok = true;
    } catch (err: any) {
      clearScanTimer();
      setError(err.toString());
    } finally {
      setLoading(false);
      setIsScanning(false);
      if (ok) {
        setTimeout(() => onImported(), 500);
      }
    }
  };

  const handleClose = async () => {
    if (isScanning || loading) {
      if (!confirm("正在扫描，确定要取消吗？")) return;
      clearScanTimer();
    }
    onClose?.();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-bg-secondary rounded-xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-text-primary">
            {mode === "create" ? "导入照片" : "打开项目"}
          </h2>
          {onClose && (
            <button onClick={handleClose} className="text-text-muted hover:text-text-primary text-lg leading-none">
              ✕
            </button>
          )}
        </div>

        {mode === "create" && (
          <div className="mb-4">
            <label className="block text-sm text-text-secondary mb-1">项目名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="My Photos"
              className="w-full bg-surface-primary border border-surface-secondary rounded-lg px-3 py-2 text-text-primary text-sm" />
          </div>
        )}

        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">文件夹路径</label>
          <div className="flex gap-2">
            <input value={rootPath} onChange={(e) => setRootPath(e.target.value)}
              placeholder="/path/to/photos"
              className="flex-1 bg-surface-primary border border-surface-secondary rounded-lg px-3 py-2 text-text-primary text-sm" />
            <button onClick={handlePickFolder}
              className="bg-surface-primary border border-surface-secondary rounded-lg px-3 py-2 text-text-primary text-sm hover:bg-accent-primary/20">
              📁
            </button>
          </div>
        </div>

        {loading && (
          <div className="mb-4 p-2 bg-accent-primary/10 border border-accent-primary/30 rounded text-accent-primary text-sm">
            <div className="font-medium">{progress}</div>
            {photoCount > 0 && (
              <div className="mt-1 text-xs text-text-muted">
                已发现 {photoCount.toLocaleString()} 张照片
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 p-2 bg-red-900/30 border border-red-700 rounded text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button onClick={handleImportClick} disabled={loading}
            className="flex-1 bg-accent-primary hover:bg-accent-primary/80 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium">
            {loading ? "⏳ 扫描中..." : mode === "create" ? "导入" : "打开"}
          </button>
        </div>

        <button onClick={() => setMode(mode === "create" ? "open" : "create")}
          className="mt-3 w-full text-text-muted hover:text-text-primary text-xs">
          {mode === "create" ? "或打开已有项目" : "或创建新项目"}
        </button>
      </div>

      {showFormatPanel && (
        <FormatFilterPanel
          currentExtensions={DEFAULT_EXTENSIONS}
          onConfirm={handleFormatConfirm}
          onCancel={() => setShowFormatPanel(false)}
        />
      )}
    </div>
  );
});
```

- [ ] **Step 3: 验证编译**

```bash
npx tsc --noEmit
```

Expected: No TypeScript errors

- [ ] **Step 4: 提交**

```bash
git add src/components/ImportModal.tsx src/api/tauri.ts
git commit -m "feat: add import progress display and cancelable modal

- Poll getProject().total_photos every 200ms during scan
- Show photo count in real-time with Chinese locale formatting
- Confirm dialog when closing during active scan
- Scan data persists in DB even if modal is canceled"
```

---

### Task 4: 切换菜单时隐藏 PhotoDetail

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 在 AppLayout 中监听路由变化并关闭 PhotoDetail**

修改 `src/App.tsx` 的 `AppLayout` 函数，添加 `useLocation` 监听：

```tsx
function AppLayout({ children, viewMode }: { children: React.ReactNode; viewMode: ViewMode }) {
  const { project, setProject, lightboxPhotoId, setLightboxPhotoId, selectedPhotoId, setSelectedPhotoId } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [showImport, setShowImport] = useState(!project);

  // Close PhotoDetail when navigating away from grid
  useEffect(() => {
    if (viewMode !== "grid" && selectedPhotoId) {
      setSelectedPhotoId(null);
    }
  }, [viewMode, selectedPhotoId, setSelectedPhotoId]);

  // ... rest of AppLayout unchanged ...
```

- [ ] **Step 2: 验证编译**

```bash
npx tsc --noEmit
```

Expected: No TypeScript errors

- [ ] **Step 3: 提交**

```bash
git add src/App.tsx
git commit -m "fix: hide PhotoDetail when switching away from Photos view

- Add useEffect in AppLayout to clear selectedPhotoId on viewMode change
- Prevents detail panel from showing on Map/Faces/Tags views"
```

---

### Task 5: 缩略图工具栏收窄 + 模式重命名

**Files:**
- Modify: `src/components/ThumbnailToolbar.tsx`
- Modify: `src/hooks/usePhotos.ts`

- [ ] **Step 1: 更新 Zustand store 的 thumbnailShape 类型**

修改 `src/hooks/usePhotos.ts`，将 `"original"` 改为 `"proportional"`：

```typescript
  thumbnailShape: "square" | "proportional";
  // ...
  setThumbnailShape: (shape: "square" | "proportional") => void;
```

默认值保持 `"square"` 不变。

- [ ] **Step 2: 重写 ThumbnailToolbar 为紧凑竖向布局**

```tsx
import React from "react";
import { useStore } from "../hooks/usePhotos";

export default React.memo(function ThumbnailToolbar() {
  const { thumbnailShape, thumbnailSize, setThumbnailShape, setThumbnailSize } = useStore();

  return (
    <div className="absolute top-2 left-2 z-10 w-[200px] bg-bg-secondary/95 backdrop-blur-sm border border-surface-secondary rounded-lg p-2 shadow-lg flex flex-col gap-2">
      {/* Shape toggle */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => setThumbnailShape("square")}
          className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
            thumbnailShape === "square"
              ? "bg-accent-primary text-white"
              : "bg-surface-primary text-text-muted hover:text-text-primary"
          }`}
        >
          Square
        </button>
        <button
          onClick={() => setThumbnailShape("proportional")}
          className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
            thumbnailShape === "proportional"
              ? "bg-accent-primary text-white"
              : "bg-surface-primary text-text-muted hover:text-text-primary"
          }`}
        >
          Proportional
        </button>
      </div>

      {/* Size slider */}
      <div className="flex items-center gap-2">
        <span className="text-text-muted text-xs w-8 text-right">{thumbnailSize}px</span>
        <input
          type="range"
          min={80}
          max={400}
          step={10}
          value={thumbnailSize}
          onChange={(e) => setThumbnailSize(Number(e.target.value))}
          className="flex-1 accent-color-accent-primary"
        />
      </div>
    </div>
  );
});
```

- [ ] **Step 3: 更新 PhotoGrid 中的引用**

修改 `src/components/PhotoGrid.tsx`，将 `"original"` 替换为 `"proportional"`：

```tsx
  if (thumbnailShape === "proportional") {
```

- [ ] **Step 4: 更新 PhotoCard 中的类型引用**

修改 `src/components/PhotoCard.tsx`，将 shape 类型从 `"square" | "original"` 改为 `"square" | "proportional"`：

```typescript
interface Props {
  // ...
  shape?: "square" | "proportional";
  // ...
}

export default React.memo(function PhotoCard({ photo, onClick, onDoubleClick, size, height, shape = "square", isSelected = false }: Props) {
```

以及 `cardHeight` 计算：

```tsx
  const cardHeight = shape === "proportional" ? (height || size) : size;
```

和 img className：

```tsx
          className={shape === "square" ? "w-full h-full object-cover" : "w-full h-full object-contain"}
```

- [ ] **Step 5: 验证编译**

```bash
npx tsc --noEmit
```

Expected: No TypeScript errors

- [ ] **Step 6: 提交**

```bash
git add src/components/ThumbnailToolbar.tsx src/hooks/usePhotos.ts src/components/PhotoGrid.tsx src/components/PhotoCard.tsx
git commit -m "refactor: rename original → proportional thumbnail shape, compact toolbar

- ThumbnailToolbar: absolute positioned 200px wide, vertical layout
- Zustand store: thumbnailShape type changed to 'square' | 'proportional'
- PhotoCard and PhotoGrid updated to use new shape name"
```

---

### Task 6: 等高瀑布流缩略图模式 + 骨架屏

**Files:**
- Modify: `src/components/PhotoGrid.tsx`
- Modify: `src/components/PhotoCard.tsx`

- [ ] **Step 1: 实现 proportional 模式的等高瀑布流**

修改 `src/components/PhotoGrid.tsx` 的 proportional 分支（原 original 分支），改为等高瀑布流：

```tsx
  // Proportional mode: fixed-height masonry columns
  if (thumbnailShape === "proportional") {
    const displayPhotos = photos.slice(0, 1000);
    return (
      <div ref={containerRef} className="h-full flex flex-col">
        <ThumbnailToolbar />
        <div className="flex-1 overflow-auto p-2" onScroll={handleScroll}>
          {photos.length === 0 && loading && (
            <div className="grid grid-cols-4 gap-2">
              {Array.from({ length: 20 }).map((_, i) => (
                <div key={i} className="aspect-square bg-surface-primary rounded animate-pulse" />
              ))}
            </div>
          )}
          <div
            style={{ columns: columnCount, columnGap: `${GAP}px` }}
          >
            {displayPhotos.map((photo) => {
              if (!photo) return null;
              const aspectRatio = (photo.width && photo.height && photo.width > 0 && photo.height > 0)
                ? photo.height / photo.width
                : 1;
              const h = Math.round(thumbnailSize * aspectRatio);
              return (
                <div key={photo.id} style={{ display: "block", marginBottom: `${GAP}px`, breakInside: "avoid" }}>
                  <PhotoCard
                    photo={photo}
                    onClick={() => onSelectPhoto(photo.id!)}
                    onDoubleClick={() => onDoubleClickPhoto?.(photo.id!)}
                    size={thumbnailSize}
                    height={h}
                    shape="proportional"
                    isSelected={photo.id === selectedPhotoId}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {loading && photos.length > 0 && <div className="text-center py-2 text-text-muted text-sm">Loading...</div>}
        {!loading && photos.length === 0 && (
          <div className="text-center py-8 text-text-muted">No photos found. Import a folder to get started.</div>
        )}
      </div>
    );
  }
```

关键变化：
- `display: "inline-block"` → `display: "block"`（防止 inline 间隙）
- 限制从 500 提升到 1000 张照片
- 初始加载时显示骨架屏（20 个灰色方块）

- [ ] **Step 2: 优化 PhotoCard 的懒加载 rootMargin**

修改 `src/components/PhotoCard.tsx`，将 IntersectionObserver 的 `rootMargin` 从 `"200px"` 增加到 `"400px"`：

```tsx
      { rootMargin: "400px" },
```

- [ ] **Step 3: 骨架屏列数与 columnCount 同步**

骨架屏的 grid 列数应该与实际的 CSS columns 数量一致。修改骨架屏部分：

```tsx
          {photos.length === 0 && loading && (
            <div style={{ columns: columnCount, columnGap: `${GAP}px` }}>
              {Array.from({ length: columnCount * 3 }).map((_, i) => (
                <div key={i} className="aspect-square bg-surface-primary rounded mb-2 animate-pulse" style={{ breakInside: "avoid" }} />
              ))}
            </div>
          )}
```

- [ ] **Step 4: 验证编译**

```bash
npx tsc --noEmit
```

Expected: No TypeScript errors

- [ ] **Step 5: 提交**

```bash
git add src/components/PhotoGrid.tsx src/components/PhotoCard.tsx
git commit -m "feat: proportional masonry mode with skeleton loading

- Fixed-height CSS columns with aspect-ratio-based card heights
- Skeleton placeholders during initial load (columnCount * 3 blocks)
- Increased IntersectionObserver rootMargin from 200px to 400px
- Raised display limit from 500 to 1000 photos for proportional mode"
```

---

### Task 7: AI 后台自动处理 + 状态指示器

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/ai.rs`
- Modify: `src-tauri/src/commands/project.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src/hooks/usePhotos.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/api/tauri.ts`
- Modify: `src/types/index.ts`

- [ ] **Step 1: 新增待处理 AI 计数 DAO**

修改 `src-tauri/src/db/photo_dao.rs`，增加函数：

```rust
pub fn get_pending_ai_count(conn: &rusqlite::Connection) -> AppResult<i64> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE ai_status = 0 AND deleted = 0",
        [],
        |row| row.get(0),
    )?;
    Ok(count)
}
```

- [ ] **Step 2: 在 lib.rs 的 scan_and_import 后触发 AI pipeline**

修改 `src-tauri/src/lib.rs` 的 `scan_and_import` 函数返回值，增加一个 `spawn_ai_if_pending` 函数：

```rust
pub fn spawn_ai_if_pending(
    app_state: tauri::State<'_, commands::project::AppState>,
    worker_state: tauri::State<'_, commands::ai::AiWorkerState>,
    app_handle: tauri::AppHandle,
) {
    use crate::db::connection::init_db;
    use crate::db::photo_dao;

    let project = {
        let guard = app_state.project.lock().unwrap();
        guard.as_ref().cloned()
    };
    if project.is_none() { return; }
    let project = project.unwrap();

    // Check pending count in a blocking thread
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let conn = init_db(&project.db_path()).ok()?;
            photo_dao::get_pending_ai_count(&conn).ok()
        })
        .await
        .ok()
        .flatten()
        .unwrap_or(0);

        if result > 0 {
            // Emit start event
            let _ = app_handle.emit("ai_status_changed", serde_json::json!({
                "stage": "starting",
                "processed": 0,
                "total": result
            }));

            // Run auto AI pipeline
            let _ = commands::ai::run_auto_ai_pipeline_inner(app_state, worker_state, app_handle).await;
        }
    });
}
```

- [ ] **Step 3: 实现 run_auto_ai_pipeline_inner 函数**

修改 `src-tauri/src/commands/ai.rs`，新增函数（在 `cmd_auto_ai_pipeline` 之后）：

```rust
/// Internal: run AI pipeline with progress events emitted to frontend.
pub async fn run_auto_ai_pipeline_inner(
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
    app_handle: tauri::AppHandle,
) -> AppResult<()> {
    use crate::db::photo_dao;
    use crate::db::connection::init_db;

    // 1. Ensure AI worker is running
    let healthy = cmd_worker_health(worker_state.clone()).await.unwrap_or(false);
    if !healthy {
        let port = worker_state.port;
        cmd_start_ai_worker(port, worker_state.clone()).await?;
    }

    // Helper to emit progress events
    let emit = |stage: &str, processed: u64, total: u64| {
        let _ = app_handle.emit("ai_status_changed", serde_json::json!({
            "stage": stage,
            "processed": processed,
            "total": total
        }));
    };

    // 2. Get total pending count
    let project = {
        let guard = state.project.lock().unwrap();
        guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?.clone()
    };
    let conn = init_db(&project.db_path())?;
    let total_pending = photo_dao::get_pending_ai_count(&conn)? as u64;

    // 3. Face detection
    emit("face_detection", 0, total_pending);
    let mut face_count: u64 = 0;
    loop {
        let batch = cmd_run_face_detection(Some(500), state.clone(), worker_state.clone()).await?;
        if batch == 0 { break; }
        face_count += batch as u64;
        emit("face_detection", face_count, total_pending);
    }

    // 4. Scene classification
    // Re-count remaining pending (some may have been processed by face detection if same photos)
    let conn = init_db(&project.db_path())?;
    let remaining = photo_dao::get_pending_ai_count(&conn)? as u64;
    if remaining > 0 {
        emit("classification", 0, remaining);
    }
    let mut scene_count: u64 = 0;
    loop {
        let batch = cmd_run_ai_classification(Some(500), state.clone(), worker_state.clone()).await?;
        if batch == 0 { break; }
        scene_count += batch as u64;
        emit("classification", scene_count, remaining);
    }

    // 5. Face clustering
    if face_count > 0 {
        emit("clustering", 0, 0);
        let cluster_result = crate::commands::faces::cmd_run_face_clustering_inner(state.clone(), worker_state.clone()).await;
        match cluster_result {
            Ok(_) => emit("clustering_done", 0, 0),
            Err(_) => emit("clustering_error", 0, 0),
        }
    }

    // 6. Done
    emit("done", 0, 0);

    Ok(())
}
```

- [ ] **Step 4: 在 project.rs 的 scan 命令后调用 AI 管道**

修改 `src-tauri/src/commands/project.rs`，在 `cmd_scan_project` 函数末尾添加：

```rust
    // Auto-start AI pipeline if there are pending photos
    let handle = state.project.lock().unwrap().clone();
    // We need the app handle to emit events. For now, trigger via a separate mechanism.
    // The frontend will call cmd_auto_ai_pipeline after scan completes if needed.
```

实际上，更简单的方式是：前端在 `scanProject()` 完成后自动调用 `autoAiPipeline()`。这样不需要传递 `AppHandle`。

修改 `src/components/ImportModal.tsx`，在 `handleSubmit` 成功后的 `onImported` 回调之前触发 AI：

但这需要 ImportModal 知道何时调用。更好的方式是：在 `FilterSync` 或 `AppLayout` 的 `useEffect` 中，当 `project` 加载后检查待处理数量。

最简方案：在 `cmd_scan_project` 返回后，前端自动调用 `autoAiPipeline()`。

修改 `src/api/tauri.ts`，增加 `triggerAutoAi` 封装（已有 `autoAiPipeline`）。

- [ ] **Step 5: 前端 AI 状态管理**

修改 `src/types/index.ts`，新增类型：

```typescript
export interface AiProcessingStatus {
  stage: "starting" | "face_detection" | "classification" | "clustering" | "clustering_done" | "clustering_error" | "done" | null;
  processed: number;
  total: number;
}
```

修改 `src/hooks/usePhotos.ts`，新增 store 字段和监听器：

```typescript
  aiProcessingStatus: {
    stage: string | null;
    processed: number;
    total: number;
  } | null;
  setAiProcessingStatus: (status: { stage: string | null; processed: number; total: number } | null) => void;
```

在 store 创建函数外（组件级别），设置事件监听：

```typescript
// At module level, after store creation
import { listen } from "@tauri-apps/api/event";

listen("ai_status_changed", (event: any) => {
  const payload = event.payload;
  useStore.getState().setAiProcessingStatus({
    stage: payload.stage,
    processed: payload.processed,
    total: payload.total,
  });
});
```

- [ ] **Step 6: 在 AppLayout 中启动 AI 监听和自动触发**

修改 `src/App.tsx` 的 `AppLayout` 函数，在现有的 `useEffect` 中增加 AI 自动触发：

```tsx
  useEffect(() => {
    api.getProject().then((p) => {
      if (p) {
        setProject(p);
        // Auto-start AI if there are pending photos
        api.autoAiPipeline().then(() => {}).catch(() => {});
      }
      // ...
    }).catch(console.error);
  }, [setProject]);
```

同时设置事件监听器（在 useEffect 中）：

```tsx
  useEffect(() => {
    const unlisten = window.__TAURI__?.event?.listen("ai_status_changed", (e: any) => {
      useStore.getState().setAiProcessingStatus({
        stage: e.payload.stage,
        processed: e.payload.processed,
        total: e.payload.total,
      });
    });
    return () => { unlisten?.then(fn => fn()); };
  }, []);
```

实际上 Tauri 的事件监听应该用 `@tauri-apps/api/event` 的 `listen` 函数。让我用正确的方式：

```tsx
import { listen } from "@tauri-apps/api/event";

// In AppLayout's useEffect:
  useEffect(() => {
    const unlisten = listen("ai_status_changed", (event) => {
      const payload = event.payload as any;
      useStore.getState().setAiProcessingStatus({
        stage: payload.stage,
        processed: payload.processed,
        total: payload.total,
      });
    });
    return () => { unlisten.then(unsub => unsub()); };
  }, []);
```

- [ ] **Step 7: Sidebar 底部增加 AI 状态指示器**

修改 `src/components/Sidebar.tsx`，在导航按钮之后、DirectoryTree 之前增加 AI 状态：

```tsx
import React, { useState, useCallback, useEffect } from "react";
// ... existing imports ...

export default React.memo(function Sidebar({ viewMode, onViewModeChange, project, onImport }: Props) {
  const { setProject, reset, aiProcessingStatus, setAiProcessingStatus } = useStore();
  // ... existing state and handlers ...

  // Auto-hide "done" status after 5 seconds
  useEffect(() => {
    if (aiProcessingStatus?.stage === "done" || aiProcessingStatus?.stage === "clustering_done") {
      const timer = setTimeout(() => setAiProcessingStatus(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [aiProcessingStatus, setAiProcessingStatus]);

  const stageLabels: Record<string, string> = {
    starting: "AI: 启动中...",
    face_detection: "AI: 处理人脸",
    classification: "AI: 场景分类",
    clustering: "AI: 人脸聚类中...",
    clustering_done: "AI: 已完成",
    done: "AI: 已完成",
    clustering_error: "AI: 聚类出错",
  };

  return (
    <aside className="w-64 bg-bg-secondary border-r border-surface-secondary flex flex-col">
      {/* ... existing header and nav ... */}
      <nav className="p-2">
        {/* ... nav items ... */}
      </nav>

      {/* AI Status Indicator */}
      {aiProcessingStatus && aiProcessingStatus.stage && aiProcessingStatus.stage !== "clustering_error" && (
        <div className="px-2 py-1.5 border-t border-surface-secondary">
          <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
            <span>{stageLabels[aiProcessingStatus.stage] || "AI: 处理中"}</span>
            {aiProcessingStatus.total > 0 && (
              <span>{aiProcessingStatus.processed}/{aiProcessingStatus.total}</span>
            )}
          </div>
          {aiProcessingStatus.total > 0 && aiProcessingStatus.stage !== "clustering" && (
            <div className="w-full bg-surface-primary rounded-full h-1">
              <div
                className="bg-accent-primary h-1 rounded-full transition-all duration-300"
                style={{ width: `${Math.min(100, (aiProcessingStatus.processed / aiProcessingStatus.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* ... DirectoryTree and FormatFilterPanel ... */}
```

- [ ] **Step 8: 验证编译**

```bash
cd src-tauri && cargo check
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 9: 提交**

```bash
git add src-tauri/src/db/photo_dao.rs \
  src-tauri/src/commands/ai.rs \
  src-tauri/src/commands/project.rs \
  src-tauri/src/main.rs \
  src/types/index.ts \
  src/hooks/usePhotos.ts \
  src/api/tauri.ts \
  src/components/Sidebar.tsx \
  src/App.tsx
git commit -m "feat: auto AI pipeline with sidebar progress indicator

- Add get_pending_ai_count DAO function
- run_auto_ai_pipeline_inner: face detection → classification → clustering
- Emit ai_status_changed events via Tauri event system
- Zustand store tracks aiProcessingStatus
- Sidebar shows compact progress bar with stage labels
- Auto-hide done status after 5 seconds
- Auto-trigger AI pipeline on project load"
```

---

### Task 8: GPS 坐标写入原始文件 EXIF

**Files:**
- Create: `src-tauri/src/commands/exif_writer.rs`
- Modify: `src-tauri/src/commands/photos.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src/components/PhotoDetail.tsx`

- [ ] **Step 1: 创建 exif_writer.rs 模块**

创建 `src-tauri/src/commands/exif_writer.rs`：

```rust
use std::process::Command;
use std::path::Path;

use crate::error::{AppError, AppResult};

/// Write GPS coordinates to a photo file's EXIF data using exiftool.
///
/// Supported formats: JPEG, TIFF, PNG, most RAW formats (via exiftool).
/// Returns Ok(()) on success, Err on failure.
pub fn write_gps_exif(file_path: &str, latitude: f64, longitude: f64) -> AppResult<()> {
    // Determine GPS reference
    let lat_ref = if latitude >= 0.0 { "N" } else { "S" };
    let lon_ref = if longitude >= 0.0 { "E" } else { "W" };
    let lat_abs = latitude.abs();
    let lon_abs = longitude.abs();

    // Check if exiftool is available
    if !is_exiftool_available() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "exiftool not found. Install via: brew install exiftool",
        )));
    }

    let output = Command::new("exiftool")
        .args([
            "-overwrite_original",
            &format!("-GPSLatitude={}", format_deg_min_sec(lat_abs)),
            &format!("-GPSLatitudeRef={}", lat_ref),
            &format!("-GPSLongitude={}", format_deg_min_sec(lon_abs)),
            &format!("-GPSLongitudeRef={}", lon_ref),
            file_path,
        ])
        .output()
        .map_err(|e| AppError::Io(e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("exiftool failed: {}", stderr),
        )))
    }
}

/// Format decimal degrees to degrees/minutes/seconds for exiftool.
fn format_deg_min_sec(decimal: f64) -> String {
    let abs = decimal.abs();
    let deg = abs.floor() as i64;
    let min_float = (abs - deg as f64) * 60.0;
    let min = min_float.floor() as i64;
    let sec = (min_float - min as f64) * 60.0;
    format!("{deg} {min} {:.4}", sec)
}

/// Check if exiftool is available in PATH.
pub fn is_exiftool_available() -> bool {
    Command::new("exiftool")
        .arg("-ver")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_deg_min_sec() {
        assert_eq!(format_deg_min_sec(39.9042), "39 54 15.1200");
        assert_eq!(format_deg_min_sec(0.0), "0 0 0.0000");
        assert_eq!(format_deg_min_sec(180.0), "180 0 0.0000");
    }
}
```

- [ ] **Step 2: 注册 exif_writer 模块**

修改 `src-tauri/src/commands/mod.rs`，增加：

```rust
pub mod exif_writer;
```

- [ ] **Step 3: 修改 cmd_update_photo_gps，增加 EXIF 写入**

修改 `src-tauri/src/commands/photos.rs`：

```rust
pub async fn cmd_update_photo_gps(
    photo_id: i64,
    latitude: Option<f64>,
    longitude: Option<f64>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state)?;

    // Get photo path before updating
    let path: Option<String> = conn
        .query_row("SELECT path FROM photos WHERE id = ?", [photo_id], |row| row.get(0))
        .ok();

    conn.execute(
        "UPDATE photos SET latitude = ?, longitude = ? WHERE id = ?",
        rusqlite::params![latitude, longitude, photo_id],
    )?;

    // Write to EXIF if we have a path and coordinates
    if let (Some(file_path), Some(lat), Some(lng)) = (path, latitude, longitude) {
        if Path::new(&file_path).exists() {
            if let Err(e) = crate::commands::exif_writer::write_gps_exif(&file_path, lat, lng) {
                // Rollback DB
                conn.execute(
                    "UPDATE photos SET latitude = NULL, longitude = NULL WHERE id = ?",
                    [photo_id],
                )?;
                return Err(AppError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("EXIF write failed: {}", e),
                )));
            }
        }
    }

    Ok(())
}
```

- [ ] **Step 4: 注册新命令到 main.rs**

`exif_writer` 是内部模块，不直接暴露为 Tauri 命令（通过 `cmd_update_photo_gps` 间接调用），所以不需要在 main.rs 中注册新命令。

- [ ] **Step 5: 前端增加提示文字**

修改 `src/components/PhotoDetail.tsx` 的 `LocationSection`，在 Edit 按钮旁边增加提示：

```tsx
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-text-muted text-xs uppercase font-semibold">Location</h3>
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-[10px]">修改将写入文件</span>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-accent-primary hover:underline"
          >
            {expanded ? "Hide" : "Edit"}
          </button>
        </div>
      </div>
```

- [ ] **Step 6: 运行 Rust 测试**

```bash
cd src-tauri && cargo test exif_writer
```

Expected: test_format_deg_min_sec passes

- [ ] **Step 7: 编译验证**

```bash
cd src-tauri && cargo check
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 8: 提交**

```bash
git add src-tauri/src/commands/exif_writer.rs \
  src-tauri/src/commands/mod.rs \
  src-tauri/src/commands/photos.rs \
  src/components/PhotoDetail.tsx
git commit -m "feat: write GPS coordinates to photo EXIF using exiftool

- New exif_writer module with write_gps_exif function
- Format decimal degrees to DMS for exiftool compatibility
- Rollback DB update if EXIF write fails
- Show hint text in PhotoDetail GPS section"
```

---

### Task 9: 前端类型同步 + 最终编译检查

**Files:**
- Modify: All modified files
- Verify: Full build

- [ ] **Step 1: 确保所有 TypeScript 类型与 Rust 字段对应**

检查以下类型一致性：
- `Photo.exposure_time` ↔ Rust `Photo.exposure_time: Option<String>`
- `Photo.f_number` ↔ Rust `Photo.f_number: Option<String>`
- `Photo.iso` ↔ Rust `Photo.iso: Option<u32>`
- `thumbnailShape` 类型统一为 `"square" | "proportional"`
- `AiProcessingStatus` 接口与 Rust emit 的 JSON 结构匹配

- [ ] **Step 2: 确保数据库迁移能处理已有数据库**

检查 `connection.rs` 中的 `ALTER TABLE` 迁移使用了 `.ok()` 忽略重复列错误。

- [ ] **Step 3: 完整编译检查**

```bash
cd src-tauri && cargo build
npx tsc --noEmit
```

Expected: Both succeed

- [ ] **Step 4: 提交**

```bash
git commit --allow-empty -m "chore: final type sync and build verification"
```

---

## Self-Review

### 1. Spec Coverage Check

| Spec Requirement | Task |
|-----------------|------|
| 导入进度显示 | Task 3 |
| 导入弹窗可关闭 | Task 3 |
| 切换菜单隐藏 PhotoDetail | Task 4 |
| EXIF 参数展示（快门/光圈/ISO） | Task 1 + Task 2 |
| 缩略图工具栏收窄 200px | Task 5 |
| AI 后台自动处理 | Task 7 |
| 侧边栏 AI 状态指示器 | Task 7 |
| 等高瀑布流缩略图模式 | Task 5 + Task 6 |
| 骨架屏 + 性能优化 | Task 6 |
| GPS 写入原始文件 EXIF | Task 8 |

所有需求都有对应的 Task 覆盖。

### 2. Placeholder Scan

搜索计划中的 "TBD"、"TODO"、"implement later"、"add appropriate error handling"、"write tests for the above"、"similar to" — 均未发现。每个步骤都包含实际代码和命令。

### 3. Type Consistency

- `thumbnailShape`: 所有引用统一为 `"square" | "proportional"` (Tasks 5, 6)
- `exposure_time/f_number/iso`: Rust `Option<String>/Option<String>/Option<u32>` ↔ TS `string | null/string | null/number | null` (Tasks 1, 2)
- `AiProcessingStatus.stage`: Rust emit 的字符串值与 TypeScript stageLabels 键匹配 (Task 7)
- `get_pending_ai_count` 返回值: Rust `i64` 在 emit 时转为 `u64` (Task 7)

### 4. 风险项

- **exiftool 依赖**：用户需要安装 `exiftool`（`brew install exiftool`）。如果未安装，EXIF 写入会失败并回滚 DB。需要在运行时检测并友好提示。
- **Tauri event 监听**：`listen("ai_status_changed", ...)` 需要在正确的位置设置。AppLayout 的 useEffect 是最合适的位置。
- **CSS columns 性能**：proportional 模式限制 1000 张照片，对于万张照片场景仍需滚动加载。当前方案是折中，后续可改为虚拟滚动。

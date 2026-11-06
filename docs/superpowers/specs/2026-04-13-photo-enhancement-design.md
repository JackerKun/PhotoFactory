# PhotoFactory 功能增强设计文档

**日期**: 2026-04-13  
**状态**: 待审批

---

## 概述

本设计文档描述 PhotoFactory 的三项功能增强，按三个阶段逐步实现：

1. **第一阶段（核心体验）**：导入进度显示、弹窗行为优化、PhotoDetail 收起、EXIF 参数展示、缩略图工具栏收窄
2. **第二阶段（性能和 AI）**：AI 后台自动处理、侧边栏状态显示、照片列表性能优化、等高瀑布流缩略图模式
3. **第三阶段（EXIF 写入）**：GPS 坐标写入原始文件 EXIF

---

## 阶段 1：核心体验

### 1.1 导入进度显示

#### 后端改动

- 将 `scan_and_import()` 拆分为两个阶段，每阶段报告进度：
  1. **文件扫描阶段**：遍历目录统计文件总数，实时更新 `scanned_count / total_count`
  2. **EXIF 读取阶段**：批量读取 EXIF 并插入数据库
- 新增 Tauri 命令 `get_scan_progress()` 返回 `{ scanned: u64, total: u64, phase: string }`
- 或者利用现有的 `getProject()` 轮询 `total_photos` 字段（更简单但精度低）

**推荐方案**：利用现有 `getProject()` 的 `total_photos` 字段在导入过程中实时更新。`scan_and_import` 在扫描文件时已逐批插入数据库，`total_photos` 会持续增长。前端只需定时轮询即可。

#### 前端改动

- `ImportModal` 组件增加进度条 UI：
  - 进度条（线性进度指示）
  - 文案：`已扫描 X / Y 张照片`
  - 当前操作提示：`正在扫描文件...` / `正在读取 EXIF...`
- 使用 `setInterval` 每 200ms 调用 `getProject()` 更新进度
- 导入完成后清除 interval

### 1.2 导入弹窗关闭行为

- 扫描**未开始**时：点击关闭按钮直接关闭 Modal，不触发任何操作
- 扫描**进行中**时：弹出确认对话框 `正在扫描，确定要取消吗？`
  - 确认：关闭 Modal，当前项目不受影响（已扫描的数据已入库，下次可继续）
  - 取消：继续扫描
- Modal 关闭后返回当前已打开项目的照片列表

### 1.3 切换菜单时隐藏 PhotoDetail

- 在 `AppLayout` 或路由监听组件中使用 `useLocation()` 监听路由变化
- 当路由从 `/` 或 `/grid` 切换到 `/map`、`/faces`、`/tags` 时：
  - 调用 store 的 `setSelectedPhotoId(null)` 关闭右侧面板
- 切回 `/` 或 `/grid` 时，面板保持关闭状态，用户需重新点击照片打开

### 1.4 EXIF 参数展示

#### 后端改动

- `exif_reader.rs` 增加读取以下 EXIF 字段：
  - `ExposureTime` → 格式化为 `1/250s` 或 `2s`
  - `FNumber` → 格式化为 `f/2.8`
  - `ISOSpeedRatings` → 格式化为 `400`
  - `PixelXDimension` / `PixelYDimension` → 格式化为 `6000 × 4000`（已有读取，需确认前端是否传递）
- `Photo` 模型新增字段（均为 `Option` 类型）：
  ```rust
  pub exposure_time: Option<String>,
  pub f_number: Option<String>,
  pub iso: Option<u32>,
  ```

#### 前端改动

- `PhotoDetail` 组件的 INFORMATION 区域增加对应展示行
- 仅当字段有值时显示该行（`Option.is_some()` 才渲染）
- 显示顺序：相机 → 尺寸 → 快门 → 光圈 → ISO

### 1.5 缩略图工具栏收窄

- `ThumbnailToolbar` 组件宽度限制为 `200px`
- 改为贴边固定定位（右侧或左侧），不占据照片网格空间
- 样式简化为紧凑竖向排列

---

## 阶段 2：性能和 AI

### 2.1 AI 后台自动处理

#### 触发时机

- 打开/导入项目后，自动查询 `ai_status = 0`（待处理）的照片数量
- 如果 `count > 0`，自动启动 AI pipeline：
  1. 启动 AI worker（如果未运行）
  2. 运行人脸检测
  3. 运行场景分类
  4. 运行人脸聚类
- 处理完毕后自动退出
- 重新扫描/刷新时，如果有新照片（`ai_status` 被重置为 0），再次自动触发

#### 后端改动

- 在 `scan_and_import` 和 `incremental_scan` 完成后，新增异步任务：
  ```rust
  async fn auto_start_ai_pipeline(app_state: &AppState) {
      let pending_count = get_pending_ai_count(&db).await;
      if pending_count > 0 {
          // emit event to frontend: AI processing started
          emit_ai_status(app_handle, "starting", 0, pending_count);
          // run pipeline stages sequentially
          // emit progress after each stage
      }
  }
  ```
- 通过 Tauri `emit` 向前端发送 AI 状态事件：
  - `ai_status_changed`: `{ stage: "face_detection" | "classification" | "clustering" | "done", processed: u64, total: u64 }`

#### 前端改动

- Zustand store 新增 `aiProcessingStatus` 字段：
  ```typescript
  aiProcessingStatus: {
    stage: string | null,
    processed: number,
    total: number,
  } | null
  ```
- `Sidebar` 组件底部监听 `aiProcessingStatus`，有值时显示进度条和状态文案
- AI 完成时显示 `AI: 已完成`，5 秒后自动消失

### 2.2 侧边栏 AI 状态指示器

位置：Sidebar 底部，导航按钮和目录树之间下方。

状态文案：
- `AI: 处理人脸 234/1000` — 人脸检测中
- `AI: 场景分类 156/800` — 场景分类中
- `AI: 人脸聚类中...` — 人脸聚类中（无进度数字）
- `AI: 已完成` — 全部处理完毕（5 秒后自动消失）
- 无待处理照片时不显示此区域

### 2.3 照片列表性能优化

#### 问题分析

- **初始加载慢**：数据库查询本身是游标分页（100条/页），但 PhotoGrid 渲染时可能需要计算所有可见卡片的布局
- **滚动卡顿**：Original 模式使用 CSS columns + 500 张照片限制，DOM 节点多导致渲染重
- **缩略图加载**：大量 `IntersectionObserver` 同时触发可能导致主线程阻塞

#### 优化方案

1. **骨架屏**：首次加载时显示灰色占位框而非 "Loading..." 文字，改善感知速度
2. **Original 模式虚拟滚动**：将 CSS columns 方案改为基于 `@tanstack/react-virtual` 的 masonry 虚拟滚动，只渲染视口内的卡片
3. **IntersectionObserver rootMargin**：从 200px 增加到 400px，提前触发懒加载，减少白块
4. **缩略图批量请求**：合并相邻卡片的缩略图路径请求，减少 Tauri invoke 调用次数
5. **Web Worker 处理**：将 `convertFileSrc` 等 URL 构建逻辑移出主线程（可选）

### 2.4 等高瀑布流缩略图模式

#### 改动

- 现有 `thumbnailShape` 状态：`"square" | "original"`
- 改为：`"square" | "proportional"`
  - `square`：保持不变（2D 虚拟网格，正方形卡片）
  - `proportional`：等高瀑布流（CSS masonry columns，每列宽度相等，照片高度按原始比例自适应）
- 移除旧的 `original` 模式（因为它不符合预期）

#### 实现

```css
/* proportional 模式 */
.photo-grid-proportional {
  column-count: var(--column-count);
  column-gap: 4px;
}

.photo-card-proportional {
  break-inside: avoid;
  margin-bottom: 4px;
  /* height 由图片原始比例决定 */
  height: calc(var(--column-width) * (photo.height / photo.width));
}
```

- 缩略图统一请求固定宽度（由列数决定），高度按比例缩放
- 虚拟滚动：使用 `@tanstack/react-virtual` 的 masonry 支持（或保持 CSS columns + 懒加载可见区域）

---

## 阶段 3：EXIF 写入

### 3.1 GPS 坐标写入原始文件

#### 改动

- `update_gps_coordinates` 命令流程：
  1. 更新 SQLite 数据库中的 `latitude` / `longitude`
  2. 调用 `write_gps_exif(file_path, lat, lng)` 写入原始文件
  3. 如果写入失败，回滚数据库中的坐标值（`UPDATE photos SET latitude = ?, longitude = ? WHERE id = ?`）
  4. 返回结果给前端

#### EXIF 写入实现

- 使用 `kamadak-exif` 库的写入功能（如果支持）或调用外部工具 `exiftool`
- macOS 系统自带 `exiftool`（通过 Homebrew 安装或打包到 Tauri app 中）
- 写入字段：
  - `GPSLatitude` / `GPSLongitude`
  - `GPSLatitudeRef` (N/S) / `GPSLongitudeRef` (E/W)
- 支持格式：JPEG、TIFF（原生支持）；RAW 格式视具体类型而定

#### 错误处理

- EXIF 写入失败时：toast 提示 `无法修改原始文件 EXIF，坐标已保存到数据库`
- 只读文件/权限问题：明确提示 `文件权限不足，无法修改 EXIF`
- RAW 格式不支持：提示 `该格式不支持写入 GPS 信息`

#### 前端改动

- PhotoDetail 的 GPS 编辑区域增加提示文字：`修改将同步写入照片文件`
- 不需要额外 UI 变更（行为是自动的）

---

## 数据流

```
用户导入文件夹
  → scan_and_import (Rust, 分批插入 DB, total_photos 增长)
    → 前端轮询 getProject() 更新进度条
  → scan_and_import 完成
    → 检查 ai_status = 0 的照片数量
      → count > 0: 启动 AI pipeline (异步)
        → emit ai_status_changed 事件
        → 前端侧边栏显示进度
      → count = 0: 跳过

用户切换菜单 (Photo → Map)
  → useLocation 检测到路由变化
    → setSelectedPhotoId(null)
    → PhotoDetail 收起

用户修改 GPS 坐标
  → update_gps_coordinates (Rust)
    → 写 DB
    → write_gps_exif (修改原始文件)
      → 失败: 回滚 DB, toast 报错
      → 成功: 返回 OK
```

---

## 文件变更清单

### Rust 端

| 文件 | 变更内容 |
|------|----------|
| `src-tauri/src/scanner/exif_reader.rs` | 增加 ExposureTime, FNumber, ISOSpeedRatings 读取 |
| `src-tauri/src/models/photo.rs` | Photo 模型新增 exposure_time, f_number, iso 字段 |
| `src-tauri/src/commands/photos.rs` | update_gps_coordinates 增加 EXIF 写入调用 |
| `src-tauri/src/commands/ai.rs` | 新增 auto_start_ai_pipeline 异步函数 |
| `src-tauri/src/main.rs` | 注册新命令，设置 AI 状态 emit |
| `src-tauri/src/lib.rs` | scan_and_import 完成后触发 AI pipeline |

### 前端

| 文件 | 变更内容 |
|------|----------|
| `src/components/ImportModal.tsx` | 增加进度条、轮询逻辑、关闭确认 |
| `src/components/Sidebar.tsx` | 底部增加 AI 状态指示器 |
| `src/components/PhotoDetail.tsx` | INFORMATION 区域增加 EXIF 参数行 |
| `src/components/PhotoGrid.tsx` | proportional 模式、骨架屏、虚拟滚动优化 |
| `src/components/PhotoCard.tsx` | proportional 模式样式、懒加载优化 |
| `src/components/ThumbnailToolbar.tsx` | 宽度限制 200px、紧凑样式 |
| `src/App.tsx` 或 `AppLayout.tsx` | 路由变化时关闭 PhotoDetail |
| `src/hooks/usePhotos.ts` | Zustand store 新增 aiProcessingStatus |
| `src/api/tauri.ts` | 新增 get_scan_progress 等 API 封装 |

---

## 风险与注意事项

1. **EXIF 写入 RAW 文件**：部分 RAW 格式（如 ARW、NEF、CR3）的 EXIF 写入支持有限。需测试常见 RAW 格式。
2. **AI 后台性能**：万张照片的 AI 处理可能耗时较长（特别是人脸检测 + embedding）。需确保不阻塞 UI 主线程。
3. **虚拟滚动 masonry**：`@tanstack/react-virtual` 对 masonry 布局的支持有限，可能需要自定义实现或使用 CSS columns + IntersectionObserver 方案。
4. **EXIF 读取性能**：万张照片的 EXIF 读取是扫描阶段的瓶颈。考虑缓存或增量读取。

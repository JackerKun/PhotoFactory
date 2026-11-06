# GPS 编辑交互改进设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改进 PhotoDetail 中 GPS 编辑流程，引入确认按钮、编辑模式隔离、切换照片时未保存更改提醒。

**Architecture:** 将 LocationSection 从"即时保存"改为"编辑→确认→保存"模式。引入编辑状态（dirty flag）和 confirm/cancel 操作。在 PhotoDetail 组件层面监听 photoId 变化，检查 dirty 状态并弹窗确认。

**Tech Stack:** React (useState, useEffect), react-leaflet, Tauri API

---

## 状态机

```
查看模式 --[点击 Edit]--> 编辑模式
编辑模式 --[点击 确认]--> 保存 EXIF + DB --> 查看模式
编辑模式 --[点击 取消]--> 丢弃更改 --> 查看模式
编辑模式 --[切换照片, dirty=true]--> 弹窗: 保存/丢弃/停留
```

## 两种模式详情

### 查看模式（默认）

**有 GPS 的照片：**
- 显示坐标文本：`39.904200, 116.407400`
- 显示小型地图（MapContainer，不可拖拽，有 Marker），点击地图直接跳转到编辑模式并设置该坐标
- 右侧 `Edit` 按钮

**无 GPS 的照片：**
- 只显示 `Location` 标题 + `Edit` 按钮
- 不显示地图，不显示坐标

### 编辑模式

点击 Edit 后进入：

**通用元素（所有照片）：**
- 提示文字：`Changes are written to the original file's EXIF data.`
- 搜索栏（输入地名，调用 Nominatim 搜索）
- 地图（可拖拽 Marker，点击设置坐标）
- 底部两个按钮：`✓ 确认`（绿色）/ `✕ 取消`（红色）

**有 GPS 的照片额外显示：**
- 当前坐标 + `Clear` 按钮（清除已有 GPS）

**无 GPS 的照片不显示：**
- Clear 按钮（因为没有 GPS 可清除）

### Dirty 状态

用户在编辑模式下点击地图或搜索设置了新坐标（但还没点确认）：
- 黄色提示条：`📍 待确认: 39.904200, 116.407400`
- `dirty = true`

### 切换照片行为

PhotoDetail 组件监听 `photoId` 变化。当 photoId 改变时：
1. 检查 LocationSection 的 dirty 状态
2. 如果 `dirty === false`：直接加载新照片
3. 如果 `dirty === true`：弹出确认框
   - **保存**：调用 `api.updatePhotoGps` 写入 EXIF + DB，然后切换
   - **丢弃**：不保存，直接切换
   - **停留**：不切换，留在当前照片继续编辑

## 数据流

```
用户点击地图 → pendingLat/pendingLng 更新 → dirty=true
用户点击确认 → api.updatePhotoGps(pendingLat, pendingLng) → 更新 photo state → dirty=false
用户点击取消 → pendingLat/pendingLng = null → dirty=false
```

## 文件变更

**修改：**
- `src/components/PhotoDetail.tsx` — 主要变更：
  - 将 LocationSection 重构为支持查看/编辑两种模式
  - 引入 pendingLat/pendingLng 状态，dirty flag
  - 编辑模式显示搜索栏 + 地图 + 确认/取消按钮
  - 查看模式：有 GPS 显示地图 + 坐标，无 GPS 只显示 Edit
  - PhotoDetail 组件监听 photoId 变化，检查 dirty 状态并弹窗
  - 将 DraggableGpsMap 的 onGpsSet 改为 setPendingGps（不立即保存）

**不修改：**
- `src-tauri/src/commands/photos.rs` — `cmd_update_photo_gps` 逻辑不变
- `src/api/tauri.ts` — API 不变

## 风险

- **react-leaflet 地图重新渲染**：切换照片时需要正确更新地图中心点。使用 `key={photoId}` 强制 MapContainer 重新挂载可避免 stale 状态。
- **EXIF 写入性能**：确认时写入 EXIF 需要调用 exiftool，可能耗时 100-500ms。确认按钮应显示 loading 状态。

# GPS 编辑交互改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 PhotoDetail 的 GPS 编辑从"即时保存"改为"编辑→确认→保存"模式，支持 dirty 状态检测和切换照片时弹窗确认。

**Architecture:** 在 PhotoDetail.tsx 内重构 LocationSection 组件，引入查看/编辑两种模式，pendingLat/pendingLng 暂存编辑值，dirtyRef/pendingRef 暴露给父组件用于 photoId 变化时的拦截确认。

**Tech Stack:** React (useState, useEffect, useRef), react-leaflet, Tauri API, Zustand (useStore for setSelectedPhotoId)

---

### Task 1: 重写 PhotoDetail.tsx — GPS 编辑完整重构

**Files:**
- Modify: `src/components/PhotoDetail.tsx` — 全部替换

**Context:** 当前 LocationSection 是 collapsed/expanded 两态，点击地图/搜索即立刻写入 EXIF。需要改为 view/edit 两态 + pending 缓冲 + 确认保存 + dirty 检测。PhotoDetail 的 photoId 变化由父组件 `selectedPhotoId` prop 控制，组件不会卸载。

- [ ] **Step 1: 读取当前 PhotoDetail.tsx 完整内容**

Run: 读取 `src/components/PhotoDetail.tsx` 当前完整代码，了解需要保留和替换的部分。

需要保留的部分：
- `MAP_CENTER`, `MAP_ZOOM` 常量
- `MapRefSetter` 组件
- `PhotoDetail` 主组件的 photo/classifications/faces/attributes 加载逻辑
- `handleAddAttribute`
- `handleUpdateGps`
- 预览图、Information、AI Tags、Faces、Custom Attributes 的 JSX 渲染

需要替换的部分：
- `DraggableGpsMap` 组件 → 拆为 `ReadOnlyGpsMap`（查看模式）和 `EditableGpsMap`（编辑模式）
- `MapClickHandler` → 改为 `TileEvents`
- `MapEvents` → 合并到 `TileEvents`
- `LocationSection` → 完全重写为 view/edit 双模式

- [ ] **Step 2: 替换顶部辅助组件**

删除现有的 `DraggableGpsMap`、`MapClickHandler`、`MapEvents`、`MapRefSetter`。替换为：

```tsx
// Read-only map for view mode (click to enter edit mode)
function ReadOnlyGpsMap({ lat, lng, onEditClick }: {
  lat: number; lng: number; onEditClick: () => void;
}) {
  return (
    <div className="h-32 rounded-lg overflow-hidden border border-surface-secondary cursor-pointer" onClick={onEditClick}>
      <MapContainer center={[lat, lng]} zoom={13} className="w-full h-full" zoomControl={false} dragging={false} scrollWheelZoom={false}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; OpenStreetMap contributors' />
        <Marker position={[lat, lng]} />
      </MapContainer>
    </div>
  );
}

// Editable map with search and draggable marker
function EditableGpsMap({ currentLat, currentLng, onGpsChange }: {
  currentLat: number | null;
  currentLng: number | null;
  onGpsChange: (lat: number, lng: number) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const center: [number, number] = (currentLat && currentLng) ? [currentLat, currentLng] : MAP_CENTER;
  const zoom = (currentLat && currentLng) ? 13 : MAP_ZOOM;

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`);
      const data = await res.json();
      if (data.length > 0) {
        const latNum = parseFloat(data[0].lat);
        const lngNum = parseFloat(data[0].lon);
        onGpsChange(latNum, lngNum);
        (window as any).__pfGpsMap?.setView([latNum, lngNum], 13);
      }
    } catch (err) {
      console.error("Geocoding failed:", err);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div>
      <div className="flex gap-1 mb-2">
        <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Search city or place..."
          className="flex-1 bg-surface-primary border border-surface-secondary rounded px-2 py-1 text-xs text-text-primary" />
        <button onClick={handleSearch} disabled={searching}
          className="bg-accent-primary text-white px-2 py-1 rounded text-xs disabled:opacity-50">
          {searching ? "..." : "Search"}
        </button>
      </div>
      <div className="h-40 rounded-lg overflow-hidden border border-surface-secondary">
        <MapContainer key={`edit-map-${currentLat}-${currentLng}`} center={center} zoom={zoom} className="w-full h-full" zoomControl={false}>
          <MapRefSetter />
          <TileEvents onGpsChange={onGpsChange} />
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; OpenStreetMap contributors' />
          {(currentLat && currentLng) && (
            <Marker position={[currentLat, currentLng]} draggable={true}
              eventHandlers={{ dragend: (e) => { const { lat, lng } = e.target.getLatLng(); onGpsChange(lat, lng); } }} />
          )}
        </MapContainer>
      </div>
    </div>
  );
}

function MapRefSetter() {
  const map = useMap();
  useEffect(() => { (window as any).__pfGpsMap = map; }, [map]);
  return null;
}

function TileEvents({ onGpsChange }: { onGpsChange: (lat: number, lng: number) => void }) {
  useMapEvents({ click(e) { onGpsChange(e.latlng.lat, e.latlng.lng); } });
  return null;
}
```

- [ ] **Step 3: 替换 LocationSection 组件**

删除现有的 `LocationSection`。替换为 view/edit 双模式版本：

```tsx
function LocationSection({ photo, onGpsSaved, dirtyRef, pendingRef }: {
  photo: Photo;
  onGpsSaved: (lat: number | null, lng: number | null) => void;
  dirtyRef: React.MutableRefObject<boolean>;
  pendingRef: React.MutableRefObject<{ lat: number | null; lng: number | null }>;
}) {
  const [editing, setEditing] = useState(false);
  const [pendingLat, setPendingLat] = useState<number | null>(null);
  const [pendingLng, setPendingLng] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Sync pending coords when photo changes or exiting edit mode
  useEffect(() => {
    if (!editing) {
      setPendingLat(photo.latitude);
      setPendingLng(photo.longitude);
    }
  }, [photo.id, photo.latitude, photo.longitude, editing]);

  // Expose dirty state and pending coords to parent
  useEffect(() => {
    dirtyRef.current = editing && (pendingLat !== photo.latitude || pendingLng !== photo.longitude);
    pendingRef.current = { lat: pendingLat, lng: pendingLng };
  }, [editing, pendingLat, pendingLng, photo.latitude, photo.longitude]);

  const handleGpsChange = (lat: number, lng: number) => {
    setPendingLat(lat);
    setPendingLng(lng);
  };

  const handleConfirm = async () => {
    setSaving(true);
    try {
      await api.updatePhotoGps(photo.id!, pendingLat, pendingLng);
      onGpsSaved(pendingLat, pendingLng);
    } catch (err) {
      alert("GPS 保存失败：" + err);
    } finally {
      setSaving(false);
      setEditing(false);
      setPendingLat(null);
      setPendingLng(null);
    }
  };

  const handleCancel = () => {
    setEditing(false);
    setPendingLat(null);
    setPendingLng(null);
  };

  const handleClear = () => {
    setPendingLat(null);
    setPendingLng(null);
  };

  const handleEdit = (clickLat?: number, clickLng?: number) => {
    if (clickLat !== undefined && clickLng !== undefined) {
      setPendingLat(clickLat);
      setPendingLng(clickLng);
    } else {
      setPendingLat(photo.latitude);
      setPendingLng(photo.longitude);
    }
    setEditing(true);
  };

  // === View mode ===
  if (!editing) {
    if (photo.latitude && photo.longitude) {
      return (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-text-muted text-xs uppercase font-semibold">Location</h3>
            <button onClick={() => handleEdit()} className="text-xs text-accent-primary hover:underline">Edit</button>
          </div>
          <p className="text-text-secondary text-xs mb-2">
            {photo.latitude.toFixed(6)}, {photo.longitude.toFixed(6)}
          </p>
          <ReadOnlyGpsMap lat={photo.latitude} lng={photo.longitude} onEditClick={() => handleEdit()} />
        </div>
      );
    }
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-text-muted text-xs uppercase font-semibold">Location</h3>
          <button onClick={() => handleEdit()} className="text-xs text-accent-primary hover:underline">Edit</button>
        </div>
      </div>
    );
  }

  // === Edit mode ===
  const displayLat = pendingLat ?? photo.latitude;
  const displayLng = pendingLng ?? photo.longitude;
  const isDirty = (pendingLat !== null || pendingLng !== null)
    && (pendingLat !== photo.latitude || pendingLng !== photo.longitude);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-text-muted text-xs uppercase font-semibold">Location</h3>
        <button onClick={handleCancel} className="text-xs text-text-muted hover:text-text-primary">Cancel</button>
      </div>
      <p className="text-text-muted text-xs mb-2">Changes are written to the original file's EXIF data.</p>

      {photo.latitude && photo.longitude && !isDirty && (
        <div className="flex items-center justify-between mb-2">
          <p className="text-text-secondary text-xs">{photo.latitude.toFixed(6)}, {photo.longitude.toFixed(6)}</p>
          <button onClick={handleClear} className="text-xs text-red-400 hover:text-red-300">Clear</button>
        </div>
      )}

      {isDirty && (
        <div className="mb-2 px-2 py-1 bg-yellow-900/30 border border-yellow-700/50 rounded text-xs text-yellow-300">
          Pending: {displayLat!.toFixed(6)}, {displayLng!.toFixed(6)}
        </div>
      )}

      <EditableGpsMap currentLat={displayLat} currentLng={displayLng} onGpsChange={handleGpsChange} />

      <div className="flex gap-2 mt-3">
        <button onClick={handleConfirm} disabled={saving}
          className="flex-1 bg-green-600 text-white py-1.5 rounded text-xs font-semibold disabled:opacity-50">
          {saving ? "Saving..." : "✓ Confirm"}
        </button>
        <button onClick={handleCancel} disabled={saving}
          className="flex-1 bg-red-600 text-white py-1.5 rounded text-xs font-semibold disabled:opacity-50">
          ✕ Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 在 PhotoDetail 中添加 dirty 检测和未保存确认对话框**

在 PhotoDetail 函数体内，现有 `useState` 之后、第一个 `useEffect` 之前添加：

```tsx
// GPS dirty state tracking
const dirtyRef = React.useRef(false);
const pendingRef = React.useRef<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });
const prevPhotoIdRef = React.useRef<number | null>(null);
const [unsavedDialog, setUnsavedDialog] = useState<{ prevId: number } | null>(null);
```

在现有的 `useEffect(() => { api.getPhoto(photoId)... }, [photoId]);` 之后添加 dirty 检测 effect：

```tsx
// Intercept photoId changes when there are unsaved GPS edits
useEffect(() => {
  const prevId = prevPhotoIdRef.current;
  if (prevId !== null && prevId !== photoId && dirtyRef.current) {
    setUnsavedDialog({ prevId });
  } else {
    prevPhotoIdRef.current = photoId;
  }
}, [photoId]);
```

在 `handleUpdateGps` 函数之后添加对话框处理函数：

```tsx
const handleUnsavedSave = async () => {
  if (unsavedDialog) {
    try {
      await api.updatePhotoGps(unsavedDialog.prevId, pendingRef.current.lat, pendingRef.current.lng);
    } catch (e) { console.error(e); }
    setUnsavedDialog(null);
    prevPhotoIdRef.current = photoId;
  }
};

const handleUnsavedDiscard = () => {
  setUnsavedDialog(null);
  prevPhotoIdRef.current = photoId;
};

const handleUnsavedStay = () => {
  useStore.getState().setSelectedPhotoId(unsavedDialog!.prevId);
  setUnsavedDialog(null);
};
```

在 JSX 中替换 `<LocationSection ... />` 调用：

```tsx
// 将原来的:
// <LocationSection photo={photo} onUpdateGps={handleUpdateGps} />
// 替换为:
<LocationSection photo={photo} onGpsSaved={handleUpdateGps} dirtyRef={dirtyRef} pendingRef={pendingRef} />
```

在 JSX 的 `</div>` 闭合标签之前（即 PhotoDetail 最外层 div 内部最后）添加未保存对话框：

```tsx
{unsavedDialog && (
  <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
    onClick={(e) => { if (e.target === e.currentTarget) handleUnsavedStay(); }}>
    <div className="bg-bg-secondary rounded-xl p-6 w-80 shadow-2xl">
      <h3 className="text-lg font-semibold mb-2 text-text-primary">未保存的 GPS 更改</h3>
      <p className="text-text-secondary text-sm mb-4">有未保存的 GPS 更改，是否保存？</p>
      <div className="flex gap-2">
        <button onClick={handleUnsavedSave}
          className="flex-1 bg-green-600 text-white py-2 rounded text-sm font-semibold hover:bg-green-500">保存</button>
        <button onClick={handleUnsavedDiscard}
          className="flex-1 bg-red-600 text-white py-2 rounded text-sm font-semibold hover:bg-red-500">丢弃</button>
        <button onClick={handleUnsavedStay}
          className="flex-1 bg-surface-primary border border-surface-secondary text-text-primary py-2 rounded text-sm hover:bg-surface-primary/80">停留</button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 5: 确保导入语句正确**

确认文件顶部导入包含所有需要的模块。现有导入应已足够：

```tsx
import React, { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
```

不需要新增导入。`useStore` 已在文件中导入（第 6 行）。`api` 也已导入（第 5 行）。

- [ ] **Step 6: TypeScript 编译检查**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: 无错误

- [ ] **Step 7: 手动测试完整流程**

1. 打开一张有 GPS 的照片 → 应该显示坐标文字 + 小地图（不可拖拽）+ Edit 按钮
2. 点击小地图 → 进入编辑模式，坐标设为点击位置
3. 点击 Cancel → 退出编辑，坐标恢复原值
4. 再次 Edit → 修改坐标 → 出现黄色 Pending 提示 → 点 Confirm → 保存成功退出编辑
5. 打开一张没有 GPS 的照片 → 应该只显示 "Location" + "Edit"
6. 点击 Edit → 显示搜索栏 + 可交互地图
7. 进入编辑模式修改坐标（dirty），用键盘方向键切换到另一张照片 → 弹出确认对话框
8. 测试"保存"按钮：保存 EXIF，切换到新照片
9. 测试"丢弃"按钮：不保存，切换到新照片
10. 测试"停留"按钮：留在当前照片，编辑状态保持

- [ ] **Step 8: 提交**

```bash
git add src/components/PhotoDetail.tsx
git commit -m "feat: GPS editing with confirm/cancel and unsaved changes dialog

Refactor LocationSection into view/edit modes. View mode shows
read-only map for photos with GPS, just Edit button for photos without.
Edit mode adds search, draggable map, and Confirm/Cancel buttons.
Changes are buffered in pending state and only written to EXIF on
Confirm. Switching photos with dirty state shows a 3-choice dialog
(Save/Discard/Stay)."
```

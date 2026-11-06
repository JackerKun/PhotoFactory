# PhotoFactory v0.2 设计文档

> 日期: 2026-04-15
> 状态: 待用户审查
> 分支: master

## 概述

PhotoFactory 是一款基于 Tauri 2 的桌面端照片管理应用。本次设计围绕三个核心方向进行增强：加载性能、人像识别分组、自动标签分组。目标是将用户体验提升到接近系统相册的水平。

---

## 设计一：加载性能方案 B

### 问题

1. **等比例模式未虚拟化**：CSS columns 瀑布流渲染全部 DOM（上限1000个），500+ 张照片时卡顿
2. **缩略图同步生成阻塞 IPC**：大文件生成缩略图时阻塞主进程
3. **无预加载策略**：滚动到底部才触发下一页加载，用户感知延迟
4. **内存无淘汰机制**：缩略图缓存 Map 无限增长
5. **地图标记无聚类**：大量 GPS 照片时全量渲染标记

### 方案

#### 1.1 虚拟滚动全覆盖

**等比例模式改用 `@tanstack/react-virtual` dynamicSize 模式。**

- 当前等比例模式使用 CSS `columns` 布局，非虚拟化
- 替换为 `useVirtualizer` + `dynamicSize` + `estimateSize` 初始估算
- 使用 `observeElementOffset` + `resizeObserver` 实现动态高度测量
- 每列宽度根据容器宽度和目标列数计算（保持 3-5 列）
- `overscan` 设为 5（瀑布流需要更多预渲染以避免空白）

**实现要点**：
```
useVirtualizer({
  count: photos.length,
  getScrollElement: () => gridRef.current,
  estimateSize: () => estimatedHeight,  // 根据宽高比估算
  overscan: 5,
  scrollPaddingStart: 20,
  scrollPaddingEnd: 20,
})
```

**DOM 元素数量**：从最多 1000 降至 50-80（取决于窗口大小）。

#### 1.2 分层缩略图

**三级缩略图架构：small (160px) → medium (400px) → original**

| 层级 | 尺寸 | 用途 | 缓存路径 |
|---|---|---|---|
| small | 160px | 网格快速浏览，首屏秒出 | `.pf/thumbnails/small/` |
| medium | 400px | 放大/悬停时升级显示 | `.pf/thumbnails/medium/` |
| original | 全尺寸 | Lightbox 全屏查看 | 按需读取原图 |

**状态机**：
```
placeholder → loading(small) → loaded(small) → upgrading(medium) → loaded(medium)
```

- small 缩略图在 PhotoCard 进入视口时立即加载（IntersectionObserver, rootMargin 200px）
- medium 缩略图在 PhotoCard 悬停或停留 > 500ms 后异步加载
- 原图仅在 Lightbox 打开时加载
- Rust 后端：`cmd_get_thumbnail_path` 接受 `size` 参数（`small` / `medium`）

#### 1.3 预加载队列

**滚动方向检测 + 前方 2 页预加载。**

- Zustand store 中维护 `preloadQueue`（待预加载照片 ID 列表）
- 监听滚动方向：向下滚动时，预加载 `cursor` 之后的 2 页（200张）缩略图
- 向上滚动时，预加载 `cursor` 之前的页面
- 后台队列：`ThumbnailProcessor` 每批处理 50 个，优先级：可视区 > 预加载 > 待处理
- 后退释放：当页面回退或筛选条件变化时，释放非可视区的 medium 缩略图内存

#### 1.4 异步缩略图生成

**`cmd_get_thumbnail_path` 改为非阻塞模式。**

- 第一步：检查缓存 → 有则立即返回路径
- 第二步：无缓存 → 返回占位路径（`placeholder.webp` 或空字符串）
- 第三步：将生成任务推入后台队列
- 第四步：后台生成完成后，通过 Tauri event 通知前端
- 前端收到通知后更新对应 PhotoCard 的缩略图 src

**Rust 端改动**：
- `photos.rs` 中 `cmd_get_thumbnail_path` 拆分为同步查询 + 异步入队
- 新增 `cmd_check_thumbnail_status` 供前端轮询（可选，event 优先）
- `thumbnail/processor.rs` 增加优先级队列（可视区照片优先）

#### 1.5 内存与 UI 优化

| 改动 | 说明 |
|---|---|
| **LRU 缩略图缓存** | Face thumbnail cache 从 `Map` 改为 LRU（最大 500 条目），超限时淘汰最近最少使用的 |
| **地图标记聚类** | 引入 `leaflet.markercluster` 插件，自动聚合近距离标记 |
| **分页优化** | LIMIT 100 → 200，加 50ms 防抖，加骨架屏动画 |
| **Zustand photos[]** | 保持现状（metadata 约 500 字节/条，10000条约5MB，可接受） |

---

## 设计二：人像识别分组

### 问题

1. DBSCAN 固定参数（eps=0.6）对不同数据集不够自适应
2. 误匹配率高，用户无法手动修正
3. 没有人物维度的浏览体验

### 方案

#### 2.1 聚类质量提升

**自适应聚类参数 + 多阈值匹配 + 质量评分。**

| 组件 | 改动 |
|---|---|
| **自适应 eps** | 根据人脸总数和特征分布动态计算：K-distance 图肘部法确定最优 eps 值 |
| **多阈值匹配** | 宽松匹配（cosine < 0.5）做候选 → 严格匹配（cosine < 0.35）确认，减少误匹配 |
| **质量评分** | 每人计算平均相似度、特征方差 → 输出可信度（高/中/低） |
| **增量聚类优化** | 新照片进入时，计算与新照片最相似的 K 个聚类做候选，投票决定归属 |
| **批量审核界面** | 低可信度人物用橙色标识，用户可一键审核 |

**FaceView 布局**：
```
┌─────────────────────────────────────┐
│ [AI 状态指示器]                      │
├─────────────────────────────────────┤
│ 已命名人物  │  未命名人物  │  待审核  │  ← Tab 切换
│ ┌───┐ ┌───┐ │ ┌───┐ ┌───┐ │ [审核按钮] │
│ │张 │ │李 │ │ 人 │ │ 人 │ │            │
│ │34 │ │28 │ │ 1 │ │ 2 │ │  低可信度   │
│ └───┘ └───┘ │ └───┘ └───┘ │  人物列表   │
└─────────────────────────────────────┘
```

- **已命名人物**：用户已命名的人物，按照片数量降序
- **未命名人物**：自动聚类产生的人物（"人物 1"、"人物 2"），可点击命名
- **待审核**：低可信度人物列表 + 批量审核按钮（显示人脸网格，用户勾选"是同一个人"/"不是"）

#### 2.2 手动标注 + 纠错

| 功能 | 实现 |
|---|---|---|
| **命名人物** | 点击人物头像 → 输入名字 → 写 SQLite `person_name` |
| **合并人物** | 多选 → "合并为同一人" → 重新计算 centroid，合并后不再拆分 |
| **拆分人物** | 人物详情页勾选"这不是他/她" → 拆出新聚类 |
| **单张标注** | Lightbox/PhotoDetail 中人脸框 → 点击标记"这是 XXX"或"忽略" |
| **约束持久化** | 用户标注写入 `face_constraints` 表（must-link / cannot-link），下次聚类作为硬约束 |

#### 2.3 人物卡片 + 抽屉详情

**人物卡片**（FaceView 网格）：
- 头像：取聚类中最清晰的一张人脸（quality 最高）
- 姓名：用户命名 / "人物 N"
- 照片数量、时间跨度

**人物详情抽屉**（右侧滑出）：
```
┌──────────────────────────────┐
│ ← 人物详情              [命名] │
├──────────────────────────────┤
│ [头像] 张三                    │
│ 34 张照片 · 2023.06 - 2024.12 │
├──────────────────────────────┤
│ 时间线                         │
│ 2024年12月  ████████ 8张       │
│ 2024年11月  █████ 5张          │
│ ...                           │
├──────────────────────────────┤
│ 常见场景标签                     │
│ [户外] [室内] [旅行]            │
├──────────────────────────────┤
│ 照片网格（点击 → 照片筛选视图）   │
│ ┌───┐ ┌───┐ ┌───┐ ┌───┐      │
│ │   │ │   │ │   │ │   │      │
│ └───┘ └───┘ └───┘ └───┘      │
└──────────────────────────────┘
```

- 抽屉使用 React 侧边栏组件（fixed position, right: 0, slide-in 动画）
- 顶部显示时间线（按月聚合的柱状图）
- 常见场景标签：基于该人物照片的 AI 场景标签统计
- 底部照片网格：点击任意照片进入 Lightbox
- 右上角 [筛选] 按钮 → 直接进入该人物的照片网格视图（URL `?person=N`）

#### 2.4 数据流

```
新照片入库
  → RetinaFace 检测 + ArcFace 特征
  → 加载 face_constraints（用户标注的 must-link/cannot-link）
  → 多阈值匹配已有人物 centroid
  → 匹配上 → 加入已有聚类（受 must-link/cannot-link 约束）
  → 未匹配 → 加入待聚类池
  → 定期/手动触发重新聚类（使用自适应 eps）
  → 更新 centroid + 人物统计 + 可信度
  → FaceView 更新
```

#### 2.5 数据库改动

**新增表 `face_constraints`**：
```sql
CREATE TABLE face_constraints (
    id INTEGER PRIMARY KEY,
    photo_id_1 INTEGER NOT NULL,
    face_index_1 INTEGER NOT NULL,
    photo_id_2 INTEGER NOT NULL,
    face_index_2 INTEGER NOT NULL,
    constraint_type TEXT NOT NULL,  -- 'must_link' | 'cannot_link'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (photo_id_1) REFERENCES photos(id),
    FOREIGN KEY (photo_id_2) REFERENCES photos(id)
);
CREATE INDEX idx_constraints_pair ON face_constraints(photo_id_1, face_index_1, photo_id_2, face_index_2);
```

**修改 `faces` 表**：
```sql
ALTER TABLE faces ADD COLUMN quality_score REAL DEFAULT 0.0;
ALTER TABLE faces ADD COLUMN person_name TEXT;
```

**新增表 `person_metadata`**：
```sql
CREATE TABLE person_metadata (
    person_id INTEGER PRIMARY KEY,
    user_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confidence TEXT DEFAULT 'medium',  -- 'high' | 'medium' | 'low'
    centroid_cached INTEGER DEFAULT 1,
    FOREIGN KEY (person_id) REFERENCES faces(person_id)
);
```

---

## 设计三：自动标签分组

### 问题

1. 现有标签扁平（110个），缺乏层级组织
2. 只有 AI 场景分类，缺少时空维度标签
3. 没有自动聚合的智能相册体验

### 方案

#### 3.1 内容识别标签（增强）

**标签层级化 + 多标签 + 代表图。**

**层级结构**：
```
一级分类（12-15个）
├── 自然
│   ├── 山 / 海 / 森林 / 湖泊 / 沙漠 / 日落 / 天空
├── 建筑
│   ├── 室内 / 室外 / 城市 / 桥梁 / 历史建筑
├── 人物
│   ├── 人像 / 群体
├── 生活
│   ├── 食物 / 饮品 / 室内装饰 / 花园
├── 交通
│   ├── 道路 / 车辆 / 航空 / 航海
├── 运动
│   ├── 水上运动 / 冬季运动 / 球类运动
├── 动物
│   ├── 野生动物 / 宠物 / 鸟类
└── 其他
    ├── 纹理 / 抽象 / 夜景 / 工业
```

**改动**：
- `classification_labels` 表增加 `parent_id` 字段实现树形结构
- 每张照片取 top-3 标签（置信度 > 阈值），而非当前 top-1
- TagView 显示：一级分类作为分组标题，下属标签为 chips，每个 chip 带代表图缩略图
- 点击一级分类 → 展开所有子标签；点击子标签 → 筛选该标签照片

#### 3.2 时空自动标签

**基于 GPS + EXIF + 时间规则自动生成，无需 AI 模型。**

| 标签类型 | 生成方式 | 存储 |
|---|---|---|
| **地点标签** | GPS → Nominatim 逆编码 → 国家/城市/地标 | `classifications` 表, `tag_type='geo_location'` |
| **时间标签** | 拍摄日期 → 年份/季节/节日 | `classifications` 表, `tag_type='time_period'` |
| **事件标签** | 时间+地点聚类（同一地点连续多天） | `classifications` 表, `tag_type='event'` |
| **设备标签** | EXIF 相机型号 | `classifications` 表, `tag_type='device'` |

**地点标签生成流程**：
```
照片有 GPS 坐标
  → 调用 Nominatim API（https://nominatim.openstreetmap.org/reverse?lat=X&lon=Y&format=json）
  → 解析响应: country → city → suburb/poi
  → 生成标签: "日本·东京" / "中国·上海·外滩"
  → 写 classifications 表
  → 注意: Nominatim 有速率限制 (1 req/s)，使用批量队列 + 本地缓存
```

**时间标签生成规则**：
```
拍摄日期 → 年份: "2024"
          → 季节: 3-5月=春, 6-8月=夏, 9-11月=秋, 12-2月=冬 → "2024年夏"
          → 节日: 春节/国庆/圣诞等（预定义日期表匹配）→ "2024春节"
```

**事件标签生成**：
```
按 GPS 坐标聚类（HDBSCAN，eps=5km）
  → 同一地点、连续 2 天以上拍摄 → 生成事件
  → 命名: "{城市}之旅 {年份}" 或 "{地标} {年月}"
```

#### 3.3 智能相册自动生成

**基于规则的自动聚合相册。**

| 相册类型 | 规则 | 命名 |
|---|---|---|
| **旅行相册** | 同一城市、≥3 天连续拍摄、≥20 张照片 | "{城市}之旅 · {天数}天 · {数量}张" |
| **月度精选** | 每月按标签多样性取 top 50 张（每种标签至少 1 张） | "{年月}精选" |
| **主题相册** | 同一标签、时间窗口内 ≥10 张 | "{标签} · {数量}张" |
| **人物相册** | 某人物出现频率最高的时间段 | "{人物名} · {时间} · {数量}张" |

**存储**：
```sql
CREATE TABLE smart_albums (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    album_type TEXT NOT NULL,  -- 'travel' | 'monthly' | 'themed' | 'person'
    rule_json TEXT NOT NULL,    -- JSON 存储生成规则
    cover_photo_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE smart_album_photos (
    album_id INTEGER NOT NULL,
    photo_id INTEGER NOT NULL,
    position INTEGER DEFAULT 0,
    PRIMARY KEY (album_id, photo_id),
    FOREIGN KEY (album_id) REFERENCES smart_albums(id),
    FOREIGN KEY (photo_id) REFERENCES photos(id)
);
```

- 相册成员不复制照片，只存关联
- 规则变更时（新照片导入、GPS 编辑）自动触发重新计算
- 用户可手动触发"重新生成相册"

#### 3.4 UI 入口

**侧边栏新增入口**：
```
侧边栏
├── 所有照片
├── 收藏夹
├── 人物          ← FaceView
├── 标签          ← TagView（增强：树形层级）
├── 相册          ← NEW: SmartAlbumView
├── 地图          ← MapView
└── 目录          ← DirectoryTree
```

**TagView 新布局**：
```
┌─────────────────────────────────────┐
│ [AI 状态指示器]                      │
├─────────────────────────────────────┤
│ 🌿 自然 (128)              [展开]    │
│   山(34) 海(28) 森林(22) 湖泊(18) ...│
│ 🏛 建筑 (96)              [展开]    │
│   室内(30) 室外(25) 城市(20) ...     │
│ 👤 人物 (85)               [展开]    │
│   人像(50) 群体(35)                 │
│ 📍 地点 (45)               [展开]    │
│   日本·东京(20) 中国·上海(15) ...    │
│ 📅 时间 (120)              [展开]    │
│   2024(80) 2024年夏(45) 2024春节(12) │
└─────────────────────────────────────┘
```

### 数据库改动

**修改 `classification_labels` 表**：
```sql
ALTER TABLE classification_labels ADD COLUMN parent_id INTEGER REFERENCES classification_labels(id);
ALTER TABLE classification_labels ADD COLUMN label_type TEXT DEFAULT 'ai_scene';
-- label_type: 'ai_scene' | 'geo_location' | 'time_period' | 'event' | 'device'
```

**修改 `classifications` 表**：
```sql
ALTER TABLE classifications ADD COLUMN confidence REAL DEFAULT 0.0;
ALTER TABLE classifications ADD COLUMN tag_type TEXT DEFAULT 'ai_scene';
-- 允许多标签: 同一 photo_id 可有多条记录
```

**新增 `smart_albums` 和 `smart_album_photos` 表**（见上文）。

---

## 整体架构

```
PhotoFactory v0.2
├── 性能提升
│   ├── 虚拟滚动全覆盖（方形 + 等比例）
│   ├── 分层缩略图（small → medium → original）
│   ├── 预加载队列（滚动方向检测 + 前方2页）
│   ├── 异步缩略图生成（非阻塞 + event 通知）
│   ├── LRU 缓存淘汰（最大 500 条目）
│   ├── 地图标记聚类（leaflet.markercluster）
│   └── 分页优化（LIMIT 200 + 防抖 + 骨架屏）
│
├── 人像识别
│   ├── 自适应聚类（肘部法 eps + 多阈值匹配）
│   ├── 质量评分 + 可信度分级
│   ├── 手动标注（命名/合并/拆分/单张标注）
│   ├── 约束持久化（must-link / cannot-link）
│   ├── 批量审核界面（FaceView 待审核 Tab）
│   └── 人物卡片 + 抽屉详情（时间线 + 场景 + 网格）
│
└── 自动标签
    ├── 标签层级化（12-15 个一级分类）
    ├── 多标签支持（top-3, 置信度 > 阈值）
    ├── 代表图（每个标签取置信度最高的照片）
    ├── 时空标签（地点/时间/事件/设备）
    ├── 智能相册（旅行/月度/主题/人物）
    └── TagView 树形层级布局
```

# PhotoFactory 功能增强设计文档

**日期**: 2026-04-16
**范围**: 相册详情页、People 视图、标签规则引擎（阶段 1）
**目标**: 统一相册浏览体验、优化人脸展示、建立标签自动打标规则引擎

---

## 一、功能概述

### 1.1 相册详情页增强
SmartAlbumView 的相册详情页复用 PhotoGrid 的完整浏览能力：缩略图 Shape 切换（Square/Proportional）、PhotoDetail 侧边栏、双击 Lightbox 大图左右查看。

### 1.2 People 视图改进
- 人脸卡片缩小，裁切范围扩大至头部/肩膀区域
- Person 详情页标题显示照片数量

### 1.3 标签规则引擎（阶段 1）
基于已有 AI 数据和 EXIF 信息自动为照片打标，包含：
- Places365 场景标签中文翻译映射
- 人脸数量规则标签（单人/双人/合影）
- 时间/季节规则标签（清晨/午后/傍晚/夜晚 + 春夏秋冬）
- 天气标签（需 GPS，通过历史天气 API）
- 色调分析标签（冷调/暖调/明亮/暗调）

---

## 二、前端设计

### 2.1 共享 PhotoGridView 组件

**问题**: PhotoGrid 的浏览能力（Shape 切换、PhotoDetail、Lightbox）目前与 `/` 路由绑定，SmartAlbumView 的相册详情页是独立实现。

**方案**: 将 PhotoGrid.tsx 中的核心浏览逻辑抽取为可复用的 `PhotoGridView` 组件，接受以下 props：
- `photos: Photo[]` — 照片列表
- `albumId?: string` — 相册 ID（可选，用于分页加载更多）
- `initialShape?: "square" | "proportional"` — 初始缩略图形状

PhotoGrid.tsx 和 SmartAlbumView.tsx 的相册详情页都改为调用 PhotoGridView。

**涉及文件**:
- `src/components/PhotoGrid.tsx` — 抽取核心逻辑
- `src/components/SmartAlbumView.tsx` — 相册详情页改用 PhotoGridView
- `src/components/PhotoDetail.tsx` — 无需改动，已可复用

### 2.2 FaceView 人脸卡片

**改动点**:
- 卡片尺寸：从 ~120px 减小到 ~80px，每行显示更多人脸
- 裁切范围：从仅脸部扩展至头部+肩膀区域。具体实现：在 face_detections.bbox 基础上，Y 轴向上扩展 40%（包含头顶和头发），Y 轴向下扩展 25%（包含脖子和部分肩膀），X 轴左右各扩展 15%（避免脸部贴边）。
- 卡片尺寸：网格列宽从固定值改为 `grid-template-columns: repeat(auto-fill, minmax(72px, 1fr))`，适配更多卡片。

**涉及文件**:
- `src/components/FaceView.tsx` — 卡片网格布局和尺寸
- `src/components/FaceThumb.tsx`（或内联）— 裁切逻辑

### 2.3 PersonHeader 显示数量

**改动点**: 标题行显示 `Person#48 (23张)`

**数据源**: Rust 端 `cmd_get_person_photo_count` 或通过 filter 查询获取

**涉及文件**:
- `src/components/PhotoGrid.tsx` 中的 PersonHeader 部分

---

## 三、后端设计

### 3.1 Places365 中文翻译映射

**位置**: `src-tauri/src/tags/places365_cn.rs`

建立 365 个 Places365 类别的英文→中文映射。例如：
- `a_airplane_cabin` → "飞机客舱"
- `b_ballroom` → "宴会厅"
- `s_stage_indoor` → "室内舞台"
- `d_dining_hall` → "餐厅大厅"

**集成点**:
- 在 `cmd_get_all_labels` 和 `cmd_get_label_hierarchy` 中增加翻译逻辑
- 前端 TagView 显示中文标签
- 数据库中仍存储英文原文（保持向后兼容），翻译在读取时动态应用

### 3.2 规则引擎入口

**位置**: `src-tauri/src/commands/tag_rules.rs`

新增命令：
- `cmd_run_tag_rules()` — 批量执行所有规则标签
- `cmd_get_tag_rules_status()` — 查看规则执行进度

**触发时机**:
1. AI pipeline 完成后自动触发（集成到 auto-pipeline 中）
2. 用户手动触发（前端按钮）

**数据库**: 规则标签存储到 `ai_classifications` 表，category 设为 `"rule"`，tag_type 区分不同规则类型：
- `rule_face_count` — 人脸数量标签
- `rule_time_period` — 时间段标签
- `rule_season` — 季节标签
- `rule_weather` — 天气标签
- `rule_tone` — 色调标签

### 3.3 人脸数量规则标签

**位置**: `src-tauri/src/tags/face_tagger.rs`

**逻辑**:
1. 查询 `face_detections` 表，按 `photo_id` 分组统计人脸数量
2. 根据数量打标：
   - 1 张脸 → `单人`
   - 2 张脸 → `双人`
   - ≥3 张脸 → `合影`
3. 插入 `ai_classifications` 表，category = `"rule"`，tag_type = `"rule_face_count"`

**依赖**: face_detection AI pipeline 已完成

### 3.4 时间/季节规则标签

**位置**: `src-tauri/src/tags/time_tagger.rs`

**时间标签逻辑**（基于 `photos.taken_at`）:
- 05:00-08:00 → `清晨`
- 08:00-11:00 → `上午`
- 11:00-14:00 → `午后`
- 14:00-17:00 → `下午`
- 17:00-19:00 → `傍晚`（可调，根据季节浮动）
- 19:00-21:00 → `黄昏`
- 21:00-05:00 → `夜晚`

**季节标签逻辑**（基于 `photos.taken_at` 月份）:
- 3-5 月 → `春天`
- 6-8 月 → `夏天`
- 9-11 月 → `秋天`
- 12-2 月 → `冬天`

### 3.5 天气标签

**位置**: `src-tauri/src/tags/weather_tagger.rs`

**逻辑**:
1. 查询有 GPS 坐标且未打天气标签的照片
2. 通过 Nominatim API 反查城市/位置名称
3. 调用历史天气 API（OpenWeatherMap History API 或其他免费源）
4. 根据天气状况打标：`晴天`、`阴天`、`雨天`、`雾天`、`雪天`
5. 缓存天气查询结果（同城市同日期不重复查询）

**注意事项**:
- 需要 API key，可通过环境变量配置
- 无 GPS 的照片跳过
- 免费天气 API 有速率限制，需要请求节流（如每秒 1 次）

**API 备选**:
- OpenWeatherMap History API（免费额度有限）
- Open-Meteo Historical Weather API（免费，无需 API key）
- Visual Crossing Weather API

### 3.6 色调分析标签

**位置**: `src-tauri/src/tags/tone_tagger.rs`

**逻辑**:
1. 读取照片的小缩略图（已有 `.pf/small/` 目录）
2. 使用 `image` crate 解码为 RGB 数据
3. 计算 HSV 色彩空间直方图
4. 判断规则：
   - 平均色相在 180-270 度 → `冷调`
   - 平均色相在 0-60 度 → `暖调`
   - 平均亮度高于阈值 → `明亮`
   - 平均亮度低于阈值 → `暗调`
5. 一张照片可以有多个色调标签

---

## 四、错误处理

### 4.1 天气 API 失败
- API 调用超时或失败时静默跳过，不阻塞其他规则
- 记录失败日志，用户可手动重试

### 4.2 色调分析失败
- 缩略图不存在或格式不支持时跳过
- 不影响照片的其他标签

### 4.3 规则重复执行
- 所有规则在插入前检查 `ai_classifications` 中是否已存在相同 label + photo_id
- 使用 INSERT OR IGNORE 防止重复

---

## 五、测试

### 5.1 单元测试
- 时间段映射函数（24 小时 → 中文标签）
- 季节映射函数（月份 → 中文季节）
- 人脸数量 → 标签映射
- 色调分析函数（输入模拟颜色 → 输出标签）
- Places365 中文映射完整性（365 个全部覆盖）

### 5.2 集成测试
- 规则引擎执行：导入一批测试照片 → 运行规则 → 验证标签数量
- 规则与 AI pipeline 集成：确认 auto-pipeline 完成后规则自动执行

---

## 六、数据模型变更

### 6.1 数据库迁移：添加 tag_type 列

`ai_classifications` 表当前只有 `category` 列，但代码中已有 `tag_type` 的引用（`get_labels_by_type` 函数）。需要添加迁移：

```sql
ALTER TABLE ai_classifications ADD COLUMN tag_type TEXT DEFAULT 'ai_scene';
```

迁移时机：应用启动时检查列是否存在，不存在则添加。

### 6.2 规则标签数据结构

规则标签复用 `ai_classifications` 表：

| 字段 | 值 |
|------|---|
| photo_id | 照片 ID |
| category | `"rule"` |
| label | 中文标签名（如 "合影"、"夜晚"、"晴天"） |
| tag_type | `"rule_face_count"` / `"rule_time_period"` / `"rule_season"` / `"rule_weather"` / `"rule_tone"` |
| confidence | `1.0`（规则确定的标签，置信度为 100%） |

**去重策略**: 使用 `INSERT OR IGNORE`，基于 `UNIQUE(photo_id, label)` 约束。如果同一照片已有相同 label 的记录（无论是 AI 还是规则生成的），不会重复插入。

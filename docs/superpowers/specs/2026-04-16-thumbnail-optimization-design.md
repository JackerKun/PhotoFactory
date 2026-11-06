# 缩略图存储结构优化与 CPU 节流设计文档

**日期**: 2026-04-16
**范围**: 缩略图存储目录结构 + 批量生成 CPU 节流
**目标**: 解决数十万缩略图在单一目录下的文件系统压力 + 限制后台批量生成时的 CPU 占用不超过 80%

---

## 一、问题

1. **单一目录压力**: 所有小缩略图存在 `.pf/thumbnails/small/` 一个目录下，数十万文件导致 `read_dir`、LRU 扫描等文件系统操作极慢
2. **CPU 飙升**: rayon `par_iter()` 默认使用所有核心，解码/缩放/编码几十张图片同时跑满 CPU

---

## 二、缩略图目录：Hash 分片

### 2.1 结构

```
.pf/thumbnails/small/
  ab/  ← hash 前 2 个字符
    cdef1234.webp  ← hash 剩余 14 个字符
    90abcdef1234.webp
  cd/
    ...
```

- hash 函数不变（SHA256 取前 16 字符 hex），只是改为 `ab/cdef1234.webp` 而非 `abcdef1234.webp`
- 256 个子目录，每个最多约千级文件（30万像素 / 256 ≈ 1172）
- 文件系统友好（ext4/HFS+/APFS 在每目录千级文件时性能良好）

### 2.2 影响范围

| 文件 | 改动 |
|------|------|
| `generator.rs` | `thumbnail_path_for` 增加分片逻辑，`generate_thumbnail` 创建子目录 |
| `eviction.rs` | `collect_entries` 改为递归遍历所有子目录 |
| `photos.rs` | `cmd_get_thumbnail_path` 使用新的 `thumbnail_path_for` 路径 |
| `tags.rs` | `cmd_get_label_preview` 使用新的 `thumbnail_path_for` 路径 |
| `processor.rs` | 调用 `generator` 的路径不变（内部自动分片） |

### 2.3 迁移策略

不需要迁移。旧缩略图仍在旧路径上（`hash.webp`），新缩略图写入新路径（`ab/cd.hash.webp`）。`cmd_get_thumbnail_path` 检查两个路径：
1. 先检查新分片路径 `ab/hash.webp`
2. 再检查旧扁平路径 `hash.webp`（兼容存量）

这样现有缩略图不会失效，新缩略图按新规则写入。LRU 驱逐时两种路径都会被扫描（`collect_entries` 递归遍历）。

---

## 三、CPU 节流

### 3.1 线程池限制

rayon 默认创建等于 CPU 逻辑核心数的线程池。改为固定 4 线程：

```rust
// processor.rs
fn process_batch(&self, project: &Project) -> AppResult<usize> {
    // ...
    let results: Vec<...> = rayon::ThreadPoolBuilder::new()
        .num_threads(4)
        .build()
        .expect("failed to build thread pool")
        .install(|| {
            items.par_iter().map(|...| { ... }).collect()
        });
    // ...
}
```

**注意**: 每批重新构建线程池成本很高。更优方案是在 `ThumbnailProcessor` 上创建一次全局线程池，后续 batch 复用。

### 3.2 每张照片处理间主动 sleep

在并行生成每张照片后主动 sleep 20ms，让出 CPU 时间片：

```rust
let success = generator::generate_small_thumbnail(source, &out_dir).is_ok();
std::thread::sleep(std::time::Duration::from_millis(20));
```

- 20ms 足够让其他进程获得 CPU 时间
- 4 线程 × 50 张照片 ≈ 每秒最多 100 张（实际上 RAW 文件每张处理 > 100ms，所以 sleep 不是瓶颈）
- CPU 不会持续满载，系统保持响应

### 3.3 批次间额外冷却

每批次处理完成后额外 sleep 500ms：

```rust
fn process_batch(&self, project: &Project) -> AppResult<usize> {
    // ... generate thumbnails ...
    // ... write to DB ...
    // ... eviction ...
    std::thread::sleep(std::time::Duration::from_millis(500));
    Ok(results.len())
}
```

### 3.4 预期效果

| 场景 | 之前 | 之后 |
|------|------|------|
| 线程数 | 等于 CPU 核心数（约 8-16） | 固定 4 |
| 单张间隔 | 无 | 20ms |
| 批次间隔 | 无 | 500ms |
| CPU 峰值 | 接近 100% | 预计 30-60% |
| 吞吐 | 极快 | 适中，可控 |

---

## 四、测试

### 4.1 单元测试
- `generator.rs`: `thumbnail_path_for` 分片路径正确性
- `eviction.rs`: 递归遍历子目录计算总大小
- `processor.rs`: 线程池配置生效

### 4.2 手动测试
- 导入一批新照片，观察 `.pf/thumbnails/small/` 下出现分片子目录
- 打开 App，观察 CPU 占用（Activity Monitor），确认不超过 80%
- 验证旧缩略图（扁平路径）仍能被找到

---

## 五、数据模型变更

无需数据库变更。缩略图路径计算在应用层完成。

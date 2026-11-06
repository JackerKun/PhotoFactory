# PhotoFactory 文件格式过滤 + 导入体验改进

## 目标

实现导入/扫描时的文件后缀过滤（不区分大小写），默认勾选常见图片格式，RAW/专业格式不勾选。增加 Sidebar 项目名显示、刷新按钮、导入下拉菜单，以及关闭弹窗的能力。

## 文件格式分组

- **常见通用格式**（默认勾选）：`jpg, jpeg, png, gif, bmp, webp, heic, heif`
- **RAW 格式**（默认不勾选）：`cr2, cr3, nef, arw, orf, rw2, pef, dng, raf, tif, tiff`
- **专业格式**（默认不勾选）：`psd, xcf, exr`

## 架构

### 后端（Rust）

1. `Project` 模型增加 `enabled_extensions: Vec<String>` 字段，持久化到 `project.json`
2. 扫描器新增 `scan_directory_with_extensions(root, extensions)` 方法，按后缀列表做不区分大小写的过滤
3. `SUPPORTED_EXTENSIONS` 扩展为全量超集（上面 23 种后缀的并集）
4. 新增 `cmd_close_project` 命令，清除内存中的当前项目状态

### 前端（React/TypeScript）

1. 新建 `FormatFilterPanel.tsx`：格式勾选面板，支持三级分组（组/单个），联动勾选
2. `Sidebar.tsx` 顶部改为：项目名 + 刷新按钮 + 导入下拉菜单（导入新文件夹 / 关闭项目）
3. `ImportModal.tsx` 右上角加 ❌ 关闭按钮
4. 导入/刷新时格式设置持久化到项目，下次打开/刷新时恢复

## 数据流

```
用户导入新文件夹
  → 弹出格式面板（常见格式默认勾选）
  → 确认后保存到 project.enabled_extensions
  → 调用 scan_directory_with_extensions(root, enabled_extensions)
  → 返回新文件数量

用户点击刷新
  → 弹出格式面板（预加载 project.enabled_extensions）
  → 确认后更新 project.enabled_extensions
  → 调用增量扫描
  → 已存在的人像/标签不变，新文件加入，已删除文件标记 deleted

用户点击导入新文件夹
  → 关闭当前项目（cmd_close_project）
  → 弹出 ImportModal
```

## 错误处理

- 扫描器忽略不支持的文件，不报错
- 格式面板没有勾选任何后缀时，阻止确认并提示
- 关闭项目后，清空 Zustand store 中的 photos/filter，回到空白状态

## 测试

- 单元测试：`scan_directory_with_extensions` 对大小写混合后缀的过滤正确性
- 单元测试：FormatFilterPanel 三级联动勾选逻辑
- 手动测试：导入、刷新、关闭、重新打开全流程

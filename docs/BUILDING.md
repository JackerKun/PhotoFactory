# PhotoFactory 构建与发布指南

## 1. 构建原则

PhotoFactory 包含 Rust/Tauri 桌面程序和 Python/ONNX Runtime 独立 AI Worker。PyInstaller 不能跨操作系统生成可执行文件，Tauri 的原生安装器也依赖对应平台。因此 DMG 必须在 macOS 构建，MSI/NSIS 和 Windows AI Worker 必须在 Windows 构建。

## 2. 通用依赖

- Node.js 20 LTS
- npm（使用 `package-lock.json`）
- Rust stable 1.75+
- Python 3.10 或 3.11（建议 3.11）
- 至少 8 GB 内存、6 GB 可用磁盘空间
- 可选：Tesseract OCR。macOS 可使用 Homebrew 安装 `tesseract` 和中文语言包；未安装不影响构建或非 OCR 功能

```bash
npm ci
```

## 3. 开发与测试

```bash
npm run tauri dev
npm test -- --run
cd src-tauri && cargo test --lib
```

当前完整 Rust 测试应包含并发缩略图发布测试。它会让多个线程同时生成同一缩略图，防止 HEIC/HEIF 转码临时文件冲突或 WebView 读取半写入的 WebP。

OCR 开发环境检查：

```bash
tesseract --version
tesseract --list-langs
```

推荐语言列表包含 `eng` 和 `chi_sim`。运行时优先使用 `chi_sim+eng`，中文语言包缺失时自动降级为 `eng`。

macOS（Homebrew）：

```bash
brew install tesseract tesseract-lang
```

Windows 可安装官方社区维护的 Tesseract 发行版，并把包含 `tesseract.exe` 的目录加入 `PATH`；再将 `chi_sim.traineddata` 放入其 `tessdata` 目录。打包版当前不会内置 Tesseract，因此发布验收必须同时覆盖“已安装 OCR”和“未安装 OCR”两种环境。

开发模式会优先使用 `ai_worker/.venv`。首次准备 AI 环境：

```bash
cd ai_worker
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python download_models.py
```

Windows 将 Python 路径替换为 `.venv\Scripts\python.exe`。

## 4. macOS DMG

```bash
chmod +x build.sh
RUN_TESTS=1 ./build.sh macos
```

脚本会准备 AI 环境、下载缺失模型、生成独立 AI Worker，并把 Worker 和模型加入 `.app` 和 DMG。

```text
src-tauri/target/release/bundle/macos/PhotoFactory.app
src-tauri/target/release/bundle/dmg/PhotoFactory_0.1.2_aarch64.dmg
```

脚本会给本地构建做 ad-hoc 资源签名，保证 `.app` 内置 AI Worker 后的资源封装完整；它不等同于 Apple Developer ID。复制到其他 Mac 仍可能触发 Gatekeeper，正式发布应配置 Developer ID 签名和公证。

## 5. Windows MSI 与安装 EXE

### 5.1 环境准备

在 Windows 10/11 x64 安装：

- Visual Studio 2022 Build Tools，并选择“使用 C++ 的桌面开发”
- Rust stable，默认 `x86_64-pc-windows-msvc`
- Node.js 20 LTS
- Python 3.11 x64
- WebView2 Runtime（Windows 11 通常已安装）

验证：

```powershell
node --version
npm --version
rustc --version
cargo --version
python --version
```

### 5.2 一键构建

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\build-windows.ps1
```

跳过测试：

```powershell
.\build-windows.ps1 -SkipTests
```

产物：

```text
src-tauri\target\release\bundle\msi\*.msi
src-tauri\target\release\bundle\nsis\*-setup.exe
```

安装包包含 `photofactory-ai.exe`、ONNX Runtime 依赖、人脸/场景模型以及量化 CLIP 语义模型，最终用户不需要 Python。

Windows Git Bash 也可以运行 `RUN_TESTS=1 ./build.sh windows`，但推荐使用 PowerShell 脚本。

## 6. GitHub Actions 四架构构建与 Release

工作流：`.github/workflows/release.yml`，名称 **Build desktop installers**。推送稳定版本标签 `vX.Y.Z` 后触发；在 Actions 页面手动运行分支只构建 artifact，不创建 Release。手动选择版本标签运行则按标签发布。

| 目标 | GitHub Runner | Rust target | 安装包 | 内置 AI Worker |
| --- | --- | --- | --- | --- |
| macOS Apple Silicon | `macos-15` | `aarch64-apple-darwin` | DMG | ARM64 原生 |
| macOS Intel | `macos-15-intel` | `x86_64-apple-darwin` | DMG | x64 原生 |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI + NSIS EXE | x64 原生 |
| Windows 11 ARM64 | `windows-11-arm` | `aarch64-pc-windows-msvc` | NSIS EXE | x64，在 Windows 11 ARM 兼容层运行 |

Windows ARM64 主程序为原生 ARM64。AI 依赖中的 OpenCV 没有 Windows ARM64 预编译包，因此该目标显式安装 x64 Python 并打包完整 x64 Worker，而不是丢失 AI 功能或混装两种架构的 Python 库。不提供 32 位 Windows：当前 AI 依赖链不能完整支持。ARM64 安装器选用 NSIS，不构建 WiX v3 MSI。

### 首次推送

提交项目源码、`.github/workflows/`、打包脚本、`package-lock.json` 和 `src-tauri/Cargo.lock`。依赖、模型、虚拟环境与构建产物由 `.gitignore` 排除，在 runner 中重建。请在仓库 Settings → Actions 中启用 GitHub Actions；仅最终发布 job 申请 `contents: write`，不需要另设个人 Token。

当前所有版本文件均为 `0.1.2`，首次发布示例：

```bash
git add .
git commit -m "Configure desktop builds and releases"
git push origin HEAD
git tag v0.1.2
git push origin v0.1.2
```

推标签前先提交并推送文件，标签必须指向包含工作流和源码的提交。后续新版本需同时更新：`package.json`、`package-lock.json`（含根包版本）、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 的主包版本；依赖版本不随意修改。可先执行：

```bash
python3 scripts/release.py version --tag v0.1.2
python3 -m unittest discover -s scripts -p test_release.py
```

校验器要求稳定的三段版本号；当前不发布预发行 / build metadata 标签。版本或锁文件不一致会在构建前失败。

### 模型不提交，如何进入安装包

每个 runner 安装 Python 依赖，运行 `ai_worker/download_models.py` 下载并验证 RetinaFace、ArcFace、Places365、CLIP 和 tokenizer，然后用 PyInstaller 打包独立 Worker。Tauri 通过 `tauri.bundle-ai.conf.json` 把 Worker 和模型放入安装包。模型使用按下载脚本内容区分的缓存，命中缓存仍会校验。下载或校验失败会让该构建失败，整个 Release 不会发布；首次构建需要能访问 Hugging Face / PyPI 等上游服务。

CI 只使用匹配平台的 Python 二进制依赖，缺少 wheel 时直接失败，不会在 runner 上意外启动复杂的源码编译。macOS Intel 会解析到仍提供 Intel wheel 的兼容依赖版本。模型下载脚本当前使用上游 `main` URL 与模型结构 / 最低大小校验，不是逐文件固定 SHA-256 的供应链锁定；输出的 SHA-256 用于安装包完整性验证。

### 发布检查与下载

1. 校验标签和六处版本记录，运行前端测试与构建。
2. 四路先安装 GPS 写回集成测试需要的 ExifTool，再运行 Rust 测试，构建独立 Worker、模型和安装包。Windows 使用官方 GitHub 的固定源码提交及 runner 自带 Perl，通过测试专用的原生启动器调用，不经过 shell 拼接。此工具仅用于 CI，安装包仍不内置 ExifTool。
3. 在无开发导入路径的临时目录启动 Worker，检查 `/health`（不等于模型推理或安装后完整验收）。
4. 汇总五个安装包，核对四架构齐全、版本和提交一致、安装包非空、文件 SHA-256 未变化。
5. 创建草稿 Release，上传全部安装包、`SHA256SUMS.txt` 和 `build-manifest.json`，上传成功后公开发布。失败时最多留下草稿，可修复后重新运行失败任务；不会发布缺架构的成功结果。

文件名示例：`PhotoFactory_0.1.2_macOS_arm64.dmg`、`PhotoFactory_0.1.2_macOS_x64.dmg`、`PhotoFactory_0.1.2_Windows_x64.msi` / `.exe`、`PhotoFactory_0.1.2_Windows_arm64.exe`。公开安装包从仓库 **Releases** 下载；手动分支构建和各架构调试产物位于 Actions → 对应运行 → Artifacts（保留 14 天）。

公开发布后的同一标签不覆盖；发布修复请使用新版本和新标签。工作流使用并发组阻止同标签重复发布互相干扰。

macOS 当前只做 ad-hoc 签名，没有 Developer ID / Apple 公证；Windows 没有代码签名证书，安装时可能有系统提示。工作流不会绕过系统安全策略。正式商用发布可另行接入签名和公证凭据。

本地 macOS 完整 Worker 必须与目标架构一致，不能仅设置 Rust target 就声称 Python Worker 已跨架构；Windows ARM64 本地构建应使用 x64 Python 和 ARM64 Rust / C++ 工具链：

```powershell
.\build-windows.ps1 -Target aarch64-pc-windows-msvc
```

参考：[GitHub Runner 架构](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[Tauri Windows 打包](https://v2.tauri.app/distribute/windows-installer/)、[PyInstaller 平台要求](https://pyinstaller.org/en/stable/requirements.html)、[OpenCV 官方 PyPI 文件](https://pypi.org/project/opencv-python-headless/#files)。

## 7. 手工构建 AI Worker

```powershell
python -m venv ai_worker\.venv
ai_worker\.venv\Scripts\python.exe -m pip install -r ai_worker\requirements.txt
ai_worker\.venv\Scripts\python.exe -m pip install "pyinstaller>=6,<7"
ai_worker\.venv\Scripts\python.exe ai_worker\download_models.py
ai_worker\.venv\Scripts\python.exe -m PyInstaller `
  --noconfirm --clean --onedir `
  --name photofactory-ai `
  --distpath ai_worker\dist `
  --workpath ai_worker\build `
  --specpath ai_worker `
  --hidden-import face_detector `
  --hidden-import scene_classifier `
  --hidden-import semantic_classifier `
  --hidden-import face_clusterer `
  --collect-all pillow_heif `
  --collect-all tokenizers `
  ai_worker\server.py
```

然后构建安装器：

```powershell
npm run tauri -- build --bundles msi,nsis --config src-tauri/tauri.bundle-ai.conf.json
```

## 8. 完整性检查

macOS：

```bash
find src-tauri/target/release/bundle/macos/PhotoFactory.app/Contents/Resources/ai_worker -maxdepth 3 -type f
hdiutil verify src-tauri/target/release/bundle/dmg/*.dmg
shasum -a 256 src-tauri/target/release/bundle/dmg/*.dmg
```

Windows：

```powershell
Get-ChildItem src-tauri\target\release\bundle -Recurse -Include *.msi,*-setup.exe
Get-FileHash src-tauri\target\release\bundle\msi\*.msi -Algorithm SHA256
Get-FileHash src-tauri\target\release\bundle\nsis\*-setup.exe -Algorithm SHA256
```

安装后应存在：

- `ai_worker/photofactory-ai.exe`（Windows）或 `ai_worker/photofactory-ai`（macOS）
- `ai_worker/models/retinaface.onnx`
- `ai_worker/models/arcface.onnx`
- `ai_worker/models/resnet50_places365.onnx`
- `ai_worker/models/clip_vision_int8.onnx`
- `ai_worker/models/clip_text_int8.onnx`
- `ai_worker/models/clip_tokenizer.json`

### 发布前功能验收

构建安装包前，建议至少使用一个包含多个子目录、横竖图、HEIC 和带 GPS 照片的项目完成以下检查：

1. 进入“All Photos”，确认顶部总数正确，持续下滑能够加载到“已加载数 = 总数”。
2. 快速切换“方格 / 原比例”并调整缩略图尺寸，确认没有重叠、异常空洞或右侧大片空白。
3. 从网格和地图打开大图，确认底部胶片条只包含当前文件夹照片，当前照片居中，并可用方向键切换。
4. 在大图中滚轮放大并使用抓手拖动，确认不会出现浏览器原生图片拖拽框；右键确认可以在 Finder/资源管理器中定位文件。
5. 在地图中分别测试 Photo Details 关闭和打开两种状态：关闭时标记显示照片卡片，打开时标记直接切换右侧详情。
6. 测试标准/卫星图层、完整地址候选搜索、单张 GPS、逐张草稿和统一位置批量保存。
7. 退出并重新打开一个尚未完成 AI 分析的项目，确认后台任务继续运行，People 和 Tags 最终能够显示持久化结果。
8. 用文件名、人物/标签、日期和相机关键词分别搜索；组合格式、ISO、光圈、GPS 和星级筛选，确认顶部总数与实际结果一致。
9. 分别按拍摄日期、导入日期、修改日期和名称进行升序/降序分页，确认没有重复或遗漏；滚动照片时确认右侧时间轴同步高亮，点击年月能滚动到目标区域且不会新增时间筛选条件。修改关键词或 EXIF 筛选后，确认右侧只显示当前结果中有数据的年月。
10. 在 Photo Details、右键菜单、批量选择和大图快捷键中设置 0–5 星，重新启动项目后确认星级仍存在，且收藏心形与星级互不影响。逐一检查 `0`–`5`、`F`、`I`、`空格/Z`、方向键和 `G/Esc`。
11. 在 People 中使用较高阈值预览自动合并，确认已命名人物不在候选中；应用一次合并并撤销。多选未命名/待审核分组执行“删除所选人物标记”，确认照片未删除且重新分析后不会立即复现；再从智能工具恢复。
12. 在智能工具中分别运行快速分析和完整分析，验证任务暂停、继续、取消、重试，以及 OCR 搜索、相似照片、最佳照片、RAW+JPEG 堆栈、回收站恢复和故事生成。
13. 同时快速点击地图中的 HEIC 缩略图和 Photo Details，确认详情不会读取半写入缓存；必要时清空 `thumbnails/large` 后验证首次生成。
14. 将测试照片设为隐私，确认普通 Photos/时间轴隐藏；在智能检索主动显示隐私照片后恢复可见。导出 XMP 前确认测试目录允许写入。

## 8.1 数据库兼容与迁移

专业资料库功能使用 `photo_intelligence`、`library_jobs`、`photo_trash`、`photo_edits`、`story_events`、`model_plugins`、`storage_sources` 和 `library_settings` 等表。`init_db` 使用 `CREATE TABLE IF NOT EXISTS` 和兼容迁移，旧 `.pf/photos.db` 打开时自动升级，不要求用户删除数据库。

发布前至少测试两种情况：

1. 从旧版本项目直接升级，确认已命名人物、标签、星级和相册仍在；
2. 删除测试项目的 `.pf` 后从零导入，确认新表、默认模型能力和设置会自动创建。

## 9. 常见构建问题

### Windows 找不到 `link.exe`

安装 Visual Studio Build Tools 的“使用 C++ 的桌面开发”，打开新的 PowerShell 后重试。

### MSI 失败但 NSIS 成功

确认企业代理允许 Tauri 获取 WiX 工具；也可以暂时只构建 NSIS：

```powershell
npm run tauri -- build --bundles nsis --config src-tauri/tauri.bundle-ai.conf.json
```

### AI Worker 体积较大

ONNX Runtime、NumPy、rawpy 和模型本身占用数百 MB。不要删除 `_internal` 或模型目录，否则安装后 AI 无法启动。

### 为什么不能直接在 Mac 生成 Windows 安装包

MinGW 只能覆盖部分 Rust 交叉编译需求，无法生成 Windows 版 PyInstaller Worker，也不能可靠完成 MSI/NSIS 打包。请使用 Windows 主机或本仓库的 Windows CI。


Windows AI 安装包默认包含 ONNX Runtime DirectML；构建会检查打包后的 worker 能否列出 DirectML。系统不支持或模型在加速后端运行失败时，worker 会自动用 CPU 继续。macOS 会尝试 Core ML，使用 CUDA 版 ONNX Runtime 的开发环境会优先尝试 CUDA。通过「后台任务 → AI 运行信息」可核对各模型选择的后端。开发时可以用 `PHOTOFACTORY_AI_PROVIDER=cpu ./start.sh` 强制 CPU，以便比较同一批照片的耗时。

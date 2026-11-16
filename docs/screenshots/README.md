# PhotoFactory 界面演示截图

这些图片来自当前仓库真实的 React 组件，运行于独立 Chrome 上下文。截图工具创建前端源码的隔离副本，用 Vite 别名替换 Tauri `invoke`、事件和文件对话框模块。正式前端、Rust 命令和用户目录不被截图工具修改。

**验证边界：**这是前端界面演示，不是 Tauri 原生截图或 Rust / SQLite / AI Worker 的端到端运行证据。36 张图片由本地程序绘制，人物头像和姓名虚构；标签、可信度、星级、相册、时间、器材、文件体积及 GPS 均为预置示例，不是 EXIF 提取、识别精度或磁盘扫描的测量结果。不要把可信度或示例数量当作实际模型表现。

| 文件 | 内容 |
| --- | --- |
| `import.webp` | 导入与打开项目窗口 |
| `library.webp` | 照片网格、目录、筛选与年月导航 |
| `viewer.webp` | 大图、详情、标签与文件夹胶片条 |
| `people.webp` | 两个预置人物分组 |
| `tags.webp` | 预置分类、来源与可信度 |
| `albums.webp` | 预置月度、主题与人物相册 |
| `memories.webp` | 两组预置回忆 |
| `memory-detail.webp` | 回忆详情、播放、导出和标签 |
| `map.webp` | 预置上海坐标、拍摄轨迹与在线 OSM 底图 |
| `tools.webp` | 智能工具入口，未执行分析任务 |
| `diagnostics.webp` | 模拟 AI 服务日志、场景分类失败和受影响照片 |

地图瓦片需要联网，并保留 Leaflet / OpenStreetMap 署名；截图中的地名搜索候选由模拟接口提供，不是地址搜索服务验收。独立演示只展示本地生成的图片，不发送个人照片。

## 维护者复现

先在仓库根目录运行 `npm ci`，再安装可选截图工具依赖。需要本机 Chrome、Node.js 和带 Pillow 的 Python 3：

```bash
cd tools/screenshots
npm install
npm run capture
```

工具在系统临时目录创建独立前端副本，复用仓库现有 Vite / React / Tailwind 依赖，用固定演示文件替代原生命令。仅监听 `127.0.0.1:1437`。输出默认写到 `docs/screenshots/`，可用 `PHOTOFACTORY_SCREENSHOT_DIR` 改变。截图完成后关闭浏览器和服务并删除前端副本。

重新生成后检查照片加载、文字和布局、地图署名及演示路径。后台任务截图应保留预置错误和服务日志，其余截图应显示正常加载的界面。

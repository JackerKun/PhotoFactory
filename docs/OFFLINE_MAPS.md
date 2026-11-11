# 离线地图：公司打包，回家导入

离线地图支持单图层 `.mbtiles` 和同时包含标准、卫星实景的双图层 `.pfmap`。公司电脑只需 Python 3.10 或更新版本，命令行可单独拷贝 `scripts/offline_map.py` 使用，不需要安装 PhotoFactory 或 AI 依赖。家里使用带有「离线地图」功能的 PhotoFactory 打开照片库并导入。

## 1. 在公司选范围和层级

在项目根目录运行 `./startOffline.sh`，或运行 `python scripts/offline_map.py --web`。工具启动后会打开本机浏览器页面，也可复制终端显示的完整地址。网页界面只需要 Python 3.10+ 和浏览器。单独复制工具时请保留 `scripts/offline_map.py`、`scripts/offline_map_web.py` 与 `scripts/offline_map_web/` 的相对位置。

工具默认打开内置街道地图，无需填写地址或申请密钥。用滚轮缩放、拖动地图，加载成功的瓦片会保存在工具自己的缓存中。默认打包已浏览的瓦片，可以直接导出多个浏览过的区域，也可以点 **框选范围** 只导出一部分。右侧可限制缩放层级。点 **估算瓦片** 查看已保存的张数和实际层级，然后点 **开始打包** 下载地图包。

内置街道地图使用 [OpenFreeMap](https://openfreemap.org/) 的 OpenStreetMap 矢量数据。浏览器把当前视图的道路、建筑和地名渲染成可导出的图片，支持浏览到 19 级。源数据的原生层级到 14 级，更深层级会用现有矢量几何重新绘制。每个街道图层包最多 3,000 张瓦片、50 MB。下载限制见 [OpenFreeMap 服务条款](https://openfreemap.org/tos/)。

要自动补齐整个选区，可改用允许离线下载的 XYZ 源，并切换到 **完整扫描框选区域**。填写自定义网址或本地瓦片目录后，点 **应用地图源**。网络中断后可用相同设置续跑。如果浏览器拦截了自动下载，点 **下载地图包**。

命令行的 `--bbox` 依次填 **西边界经度、南边界纬度、东边界经度、北边界纬度**，单位是 WGS84 十进制度，西经、南纬填负数。`--name` 是导入后显示的名字。`--min-zoom`、`--max-zoom` 指定包含两端的层级。先加 `--dry-run` 看瓦片数量，再去掉它下载。

例如，打包上海及周边的区域概览。Windows 用 `python`，macOS/Linux 可换成 `python3`：

```bash
python scripts/offline_map.py --name "上海及周边" --bbox=120.85,30.65,122.0,31.9 --min-zoom 2 --max-zoom 8 --output shanghai.mbtiles --dry-run
python scripts/offline_map.py --name "上海及周边" --bbox=120.85,30.65,122.0,31.9 --min-zoom 2 --max-zoom 8 --output shanghai.mbtiles
```

默认下载 [NASA GIBS Blue Marble](https://worldview.earthdata.nasa.gov/) 卫星概览，原生层级 0–8，无需密钥，适合看大范围地貌。放大能看照片定位，但不会出现新的街道细节。

## 2. 需要道路和街区细节时

使用允许下载、离线存储的 Web Mercator XYZ 栅格地图服务，或由本地数据渲染出的 `z/x/y.png`、`z/x/y.jpg`、`z/x/y.webp` 瓦片目录。支持层级 0–19，实际以地图源提供的层级为准。同一个包内使用同一种图像格式。

```bash
# 将示例地址换成你获准离线使用的 XYZ 服务
python scripts/offline_map.py --name "上海街道" --bbox=121.40,31.15,121.55,31.28 --min-zoom 10 --max-zoom 16 --layer standard --tile-url 'https://tiles.example.com/{z}/{x}/{y}.png' --attribution '地图数据来源' --output shanghai-streets.mbtiles

# 或打包已经生成的本地瓦片
python scripts/offline_map.py --name "上海街道" --bbox=121.40,31.15,121.55,31.28 --min-zoom 10 --max-zoom 16 --layer standard --tile-dir ./tiles --attribution '地图数据来源' --output shanghai-streets.mbtiles
```

`--layer standard` 显示在标准地图，`--layer satellite` 显示在卫星地图。自定义 URL 需要指定来源署名。工具不会批量下载应用原有的 [OpenStreetMap 公共瓦片](https://operations.osmfoundation.org/policies/tiles/) 或 [Esri 在线 World Imagery 瓦片](https://support.esri.com/en-us/knowledge-base/problem-unable-to-export-a-tile-package-from-the-world--000014855)。

同一区域每升一级通常需要约四倍瓦片。大区域先选较低层级，只为常去的街区另打高层级小包。默认单次上限 20,000 张，可以用 `--max-tiles` 调整；单个成品上限 32 GiB。下载中断时会保留 `.mbtiles.part`，用相同命令可继续，完成后只拷贝 `.mbtiles` 成品。跨越 ±180° 的区域需要分成两个包。

### 一次生成两种地图

选择 **两种地图** 后，可分别设置标准地图与卫星地图的来源和层级。导出已浏览的瓦片前，用顶部的预览菜单分别浏览两种地图。导出会生成一个包含双图层的 `.pfmap`。完整扫描模式会先处理标准地图，再处理卫星地图。

Natural Earth 标准概览提供 0–6 级，NASA Blue Marble 卫星概览提供 0–8 级。需要更详细的卫星影像时，可选用允许离线下载的 XYZ 网址，或使用已有的本地 XYZ 瓦片目录。

命令行示例使用两个本地 XYZ 目录：

```bash
python scripts/offline_map.py --name "上海周边" --bbox=121.40,31.15,121.55,31.28 --layer both --tile-dir ./streets --min-zoom 10 --max-zoom 16 --satellite-dir ./imagery --satellite-min-zoom 8 --satellite-max-zoom 14 --output shanghai.pfmap
```

卫星来源为网址时，用 `--satellite-url` 和 `--satellite-attribution`。两种卫星来源参数都省略时，默认下载 NASA 2–8 级概览。中断后保留 `.pfmap.parts` 目录和临时文件，使用相同设置可继续。拷贝时只需带上生成的 `.pfmap` 成品。

## 3. 在家导入和查看

1. 把成品 `.pfmap` 或 `.mbtiles` 拷到 U 盘或移动硬盘。
2. 在 PhotoFactory 打开照片库，点击地图右上角与标准地图、卫星实景地图并排的 **离线地图** 图标，再选择 **导入离线地图包**。
3. 可一次选中多个文件。导入 `.pfmap` 会同时安装两个图层并保留当前视角。首次打开地图页显示世界地图，之后恢复上次的位置和缩放。点击离线地图列表中的地图包可以定位到覆盖区域。导入完成后即可拔掉 U 盘。

应用将地图包复制到当前照片库的 `.pf/maps/offline/`，按标准、卫星图层分目录。它与普通在线缓存 `.pf/maps/tiles/` 分开，不受普通缓存清理影响。备份照片库时带上 `.pf` 即可保留已导入的地图。

地图依次读取详细离线包、相册缓存、在线地图。详细瓦片都不可用时，使用已导入的 Natural Earth 或 NASA 概览。断网时仍可查看本地覆盖范围。照片 GPS 标记和地图选点仍可使用，在线地址搜索需联网。第三方包须为 [MBTiles](https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md) TMS 行号，包含 `metadata`、`tiles` 普通表，且瓦片为 PNG、JPEG 或 WebP；矢量包不能直接导入。

## 4. 导出已经保存的地图

点击 **离线地图** 图标，选择 **标准地图**、**卫星实景地图** 或 **两种地图**，再点 **导出离线地图**。选择两种地图时输出一个 `.pfmap`，两个图层都要有本地瓦片。导出包含所选图层当前缓存和已导入的瓦片。同一坐标重复时依次优先使用详细离线包、相册缓存和概览。导出过程只读取本地数据，生成的文件可以在另一台电脑上导入。

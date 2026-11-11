//! Raster MBTiles packages are kept separately from the evictable online cache.
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use crate::error::{AppError, AppResult};

const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const BUNDLE_MAGIC: &[u8; 8] = b"PFMAP001";
const BUNDLE_HEADER_BYTES: u64 = 24;
const LAYERS: [&str; 2] = ["standard", "satellite"];

#[derive(Debug, Serialize)]
pub struct OfflineMap {
    pub id: String,
    pub name: String,
    pub layer: String,
    pub min_zoom: u32,
    pub max_zoom: u32,
    pub bounds: Option<[f64; 4]>, // west, south, east, north
    pub attribution: Option<String>,
    pub bytes: u64,
}

fn invalid(message: &str) -> AppError {
    AppError::Project(format!("离线地图：{message}"))
}

fn open_package(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")?;
    Ok(conn)
}

fn metadata(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT substr(value,1,500) FROM metadata WHERE name=?1 LIMIT 1",
            [key],
            |row| row.get(0),
        )
        .optional()?)
}

fn parse_bounds(value: &str) -> Option<[f64; 4]> {
    let coords: Vec<f64> = value
        .split(',')
        .map(|v| v.trim().parse())
        .collect::<Result<_, _>>()
        .ok()?;
    let [w, s, e, n] = <[f64; 4]>::try_from(coords).ok()?;
    if w >= -180.0 && e <= 180.0 && s >= -85.051129 && n <= 85.051129 && w < e && s < n {
        Some([w, s, e, n])
    } else {
        None
    }
}

fn mime_type(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

fn inspect(path: &Path, conn: &Connection) -> AppResult<OfflineMap> {
    // Validate ordinary tables before querying a database from removable media.
    // The packer emits this flat schema; arbitrary SQL views are not evaluated.
    let table_count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_list WHERE schema='main' AND type='table' AND name IN ('metadata','tiles')",
        [],
        |row| row.get(0),
    )?;
    if table_count != 2 {
        return Err(invalid("需要包含 metadata 和 tiles 表的栅格 MBTiles"));
    }
    if metadata(conn, "scheme")?.is_some_and(|scheme| !scheme.eq_ignore_ascii_case("tms")) {
        return Err(invalid("地图包必须使用 MBTiles 的 TMS 行号"));
    }
    let format = metadata(conn, "format")?
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(format.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err(invalid("只支持 PNG、JPEG 或 WebP 栅格 MBTiles 地图包"));
    }
    let layer = metadata(conn, "photofactory_layer")?.unwrap_or_else(|| "standard".into());
    if !LAYERS.contains(&layer.as_str()) {
        return Err(invalid("地图包类型无效"));
    }
    let min_zoom: u32 = conn.query_row(
        "SELECT zoom_level FROM tiles ORDER BY zoom_level ASC LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let max_zoom: u32 = conn.query_row(
        "SELECT zoom_level FROM tiles ORDER BY zoom_level DESC LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    if max_zoom > 19 {
        return Err(invalid("支持的缩放级别为 0–19"));
    }
    let id = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let name = metadata(conn, "name")?
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| invalid("地图包缺少名称（metadata.name）"))?;
    Ok(OfflineMap {
        id,
        name,
        layer,
        min_zoom,
        max_zoom,
        bounds: metadata(conn, "bounds")?.and_then(|b| parse_bounds(&b)),
        attribution: metadata(conn, "attribution")?.filter(|v| !v.trim().is_empty()),
        bytes: path.metadata()?.len(),
    })
}

fn package_paths(dir: &Path) -> AppResult<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("mbtiles"))
        {
            files.push((entry.metadata()?.modified().ok(), entry.path()));
        }
    }
    files.sort_unstable_by(|a, b| b.cmp(a));
    Ok(files.into_iter().map(|(_, path)| path).collect())
}

pub fn list_packages(dir: &Path) -> AppResult<Vec<OfflineMap>> {
    let mut packages = Vec::new();
    for layer in LAYERS {
        for path in package_paths(&dir.join(layer))? {
            if let Ok(info) = open_package(&path).and_then(|conn| inspect(&path, &conn)) {
                packages.push(info);
            }
        }
    }
    Ok(packages)
}

struct StagedMap {
    file: tempfile::NamedTempFile,
    info: OfflineMap,
}

fn stage_package(reader: impl Read, bytes: u64, dir: &Path) -> AppResult<StagedMap> {
    if bytes == 0 || bytes > MAX_PACKAGE_BYTES {
        return Err(invalid("每个图层的地图包不得超过 32 GiB"));
    }
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    if std::io::copy(&mut reader.take(bytes), file.as_file_mut())? != bytes {
        return Err(invalid("地图包不完整，请重新复制"));
    }
    let conn = open_package(file.path())?;
    let info = inspect(file.path(), &conn)?;
    let integrity: String = conn.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(invalid("地图包数据库损坏"));
    }
    let sample: Vec<u8> = conn.query_row(
        "SELECT tile_data FROM tiles WHERE length(tile_data) BETWEEN 1 AND ?1 LIMIT 1",
        [MAX_TILE_BYTES],
        |row| row.get(0),
    )?;
    if mime_type(&sample).is_none() {
        return Err(invalid("地图包内没有有效的栅格瓦片"));
    }
    drop(conn);
    Ok(StagedMap { file, info })
}

fn commit_maps(staged: Vec<StagedMap>, dir: &Path) -> AppResult<Vec<OfflineMap>> {
    let mut installed = Vec::new();
    let mut results = Vec::new();
    for StagedMap { file, info } in staged {
        let folder = dir.join(&info.layer);
        let id = format!("{}.mbtiles", uuid::Uuid::new_v4());
        let path = folder.join(&id);
        let result = fs::create_dir_all(&folder)
            .and_then(|_| file.persist_noclobber(&path).map_err(|error| error.error));
        if let Err(error) = result {
            for path in installed {
                let _ = fs::remove_file(path);
            }
            return Err(error.into());
        }
        installed.push(path);
        results.push(OfflineMap { id, ..info });
    }
    Ok(results)
}

pub fn import_packages(sources: &[PathBuf], dir: &Path) -> AppResult<Vec<OfflineMap>> {
    if sources.is_empty() {
        return Err(invalid("请选择至少一个离线地图包"));
    }
    fs::create_dir_all(dir)?;
    let mut staged = Vec::new();
    for source in sources {
        if !source.metadata()?.is_file() {
            return Err(invalid("请选择地图包文件"));
        }
        let mut reader = std::io::BufReader::new(fs::File::open(source)?);
        let bytes = reader.get_ref().metadata()?.len();
        let extension = source
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default();
        if extension.eq_ignore_ascii_case("mbtiles") {
            staged.push(stage_package(reader, bytes, dir)?);
        } else if extension.eq_ignore_ascii_case("pfmap") {
            let mut header = [0u8; BUNDLE_HEADER_BYTES as usize];
            reader
                .read_exact(&mut header)
                .map_err(|_| invalid("双图层地图包不完整"))?;
            let lengths = [
                u64::from_le_bytes(header[8..16].try_into().unwrap()),
                u64::from_le_bytes(header[16..24].try_into().unwrap()),
            ];
            if &header[..8] != BUNDLE_MAGIC
                || lengths
                    .iter()
                    .any(|&length| length == 0 || length > MAX_PACKAGE_BYTES)
                || lengths.iter().sum::<u64>() + BUNDLE_HEADER_BYTES != bytes
            {
                return Err(invalid("双图层地图包格式错误或文件不完整"));
            }
            for (layer, length) in LAYERS.into_iter().zip(lengths) {
                let map = stage_package(&mut reader, length, dir)?;
                if map.info.layer != layer {
                    return Err(invalid("双图层地图包中的地图类型不匹配"));
                }
                staged.push(map);
            }
        } else {
            return Err(invalid("请选择 .pfmap 或 .mbtiles 文件"));
        }
    }
    // Validate every source before making either layer available to the viewer.
    commit_maps(staged, dir)
}

#[cfg(test)]
pub(crate) fn import_package(source: &Path, dir: &Path) -> AppResult<OfflineMap> {
    Ok(import_packages(&[source.to_path_buf()], dir)?.remove(0))
}

fn overview_package(conn: &Connection) -> AppResult<bool> {
    Ok(matches!(
        metadata(conn, "attribution")?.as_deref(),
        Some("Made with Natural Earth" | "NASA Earthdata / GIBS — Blue Marble")
    ))
}

fn has_overview_index(conn: &Connection) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_list WHERE schema='main' AND type='table' AND name='photofactory_overview_tiles')",
        [],
        |row| row.get(0),
    )?)
}

#[derive(Default)]
pub struct TileOptions {
    pub detail: Option<String>,
    pub overview: Option<String>,
}

pub fn tile_options(dir: &Path, layer: &str, z: u32, x: u32, y: u32) -> AppResult<TileOptions> {
    if !LAYERS.contains(&layer) || z > 19 || x >= 1 << z || y >= 1 << z {
        return Err(invalid("瓦片坐标或地图类型无效"));
    }
    let row = (1u32 << z) - 1 - y; // Leaflet XYZ → MBTiles TMS
    let mut options = TileOptions::default();
    for path in package_paths(&dir.join(layer))? {
        let data = open_package(&path).and_then(|conn| {
            let data = conn.query_row(
                "SELECT tile_data FROM tiles WHERE zoom_level=?1 AND tile_column=?2 AND tile_row=?3 AND length(tile_data) BETWEEN 1 AND ?4 LIMIT 1",
                rusqlite::params![z, x, row, MAX_TILE_BYTES],
                |r| r.get::<_, Vec<u8>>(0),
            ).optional()?;
            let Some(data) = data else { return Ok(None) };
            let overview = if has_overview_index(&conn)? {
                conn.query_row(
                    "SELECT EXISTS (SELECT 1 FROM photofactory_overview_tiles WHERE zoom_level=?1 AND tile_column=?2 AND tile_row=?3)",
                    rusqlite::params![z, x, row],
                    |r| r.get(0),
                )?
            } else {
                overview_package(&conn)?
            };
            Ok(Some((data, overview)))
        });
        if let Ok(Some((data, overview))) = data {
            if let Some(mime) = mime_type(&data) {
                if overview && options.overview.is_some() {
                    continue;
                }
                let url = format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(data)
                );
                if overview {
                    options.overview = Some(url);
                } else {
                    options.detail = Some(url);
                    break;
                }
            }
        }
    }
    Ok(options)
}

#[cfg(test)]
fn tile_data_url(dir: &Path, layer: &str, z: u32, x: u32, y: u32) -> AppResult<Option<String>> {
    let options = tile_options(dir, layer, z, x, y)?;
    Ok(options.detail.or(options.overview))
}

#[derive(Debug, Serialize)]
pub struct ExportedMap {
    pub tile_count: u64,
    pub bytes: u64,
}

// Cache paths are XYZ. Convert the row to TMS when writing MBTiles.
fn cached_tile_coords(path: &Path) -> Option<(u32, u32, u32)> {
    let mut parts = path.iter();
    let z: u32 = parts.next()?.to_str()?.parse().ok()?;
    let x: u32 = parts.next()?.to_str()?.parse().ok()?;
    let filename = Path::new(parts.next()?);
    if parts.next().is_some()
        || !matches!(
            filename.extension()?.to_str()?,
            "png" | "jpg" | "jpeg" | "webp"
        )
    {
        return None;
    }
    let y: u32 = filename.file_stem()?.to_str()?.parse().ok()?;
    if z > 19 || x >= 1 << z || y >= 1 << z {
        return None;
    }
    Some((z, x, (1 << z) - 1 - y))
}

fn export_tile(conn: &Connection, coords: (u32, u32, u32), data: &[u8]) -> AppResult<bool> {
    let (z, x, row) = coords;
    if data.len() > MAX_TILE_BYTES || mime_type(data).is_none() {
        return Ok(false);
    }
    let params = rusqlite::params![z, x, row];
    let mut exists = conn.prepare_cached(
        "SELECT 1 FROM tiles WHERE zoom_level=?1 AND tile_column=?2 AND tile_row=?3",
    )?;
    if exists.exists(params)? {
        return Ok(false);
    }
    // A package has one raster format. Lossless WebP allows cached JPEG/PNG
    // and imported PNG/JPEG/WebP tiles to coexist without losing alpha.
    let mut reader = image::ImageReader::new(std::io::Cursor::new(data)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let Ok(image) = reader.decode() else {
        return Ok(false);
    };
    let mut encoded = std::io::Cursor::new(Vec::new());
    let bytes = if mime_type(data) == Some("image/webp") {
        data
    } else {
        image
            .to_rgba8()
            .write_to(&mut encoded, image::ImageFormat::WebP)?;
        encoded.get_ref()
    };
    if bytes.len() > MAX_TILE_BYTES {
        return Err(invalid("转换后的瓦片超过 2 MiB，无法导出"));
    }
    conn.prepare_cached("INSERT INTO tiles VALUES (?1,?2,?3,?4)")?
        .execute(rusqlite::params![z, x, row, bytes])?;
    Ok(true)
}

fn copy_imported_tiles(
    target: &Connection,
    packages: &[PathBuf],
    overview: bool,
    credits: &mut std::collections::BTreeSet<String>,
) -> AppResult<u64> {
    let mut count = 0;
    for path in packages {
        let source = open_package(path)?;
        let info = inspect(path, &source)?;
        let indexed = has_overview_index(&source)?;
        if !indexed && overview_package(&source)? != overview {
            continue;
        }
        let quality_filter = if indexed {
            " AND EXISTS (SELECT 1 FROM photofactory_overview_tiles AS o
                          WHERE o.zoom_level=t.zoom_level AND o.tile_column=t.tile_column
                            AND o.tile_row=t.tile_row) = ?2"
        } else {
            " AND ?2 IN (0,1)"
        };
        let mut query = source.prepare(&format!(
            "SELECT zoom_level,tile_column,tile_row,tile_data FROM tiles AS t
             WHERE zoom_level BETWEEN 0 AND 19 AND tile_column >= 0 AND tile_column < (1 << zoom_level)
               AND tile_row >= 0 AND tile_row < (1 << zoom_level) AND length(tile_data) BETWEEN 1 AND ?1{quality_filter}",
        ))?;
        let mut rows = query.query(rusqlite::params![MAX_TILE_BYTES, overview])?;
        let before = count;
        while let Some(row) = rows.next()? {
            let coords = (row.get(0)?, row.get(1)?, row.get(2)?);
            let data = row
                .get_ref(3)?
                .as_blob()
                .map_err(|_| invalid("地图包瓦片数据无效"))?;
            if export_tile(target, coords, data)? {
                count += 1;
                if overview {
                    target
                        .prepare_cached(
                            "INSERT INTO photofactory_overview_tiles VALUES (?1,?2,?3)",
                        )?
                        .execute(rusqlite::params![coords.0, coords.1, coords.2])?;
                }
            }
        }
        if count > before {
            credits.extend(info.attribution);
        }
    }
    Ok(count)
}

pub fn export_package(
    offline_dir: &Path,
    cache_dir: &Path,
    destination: &Path,
    name: &str,
    layer: &str,
) -> AppResult<ExportedMap> {
    if !LAYERS.contains(&layer)
        || !destination
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mbtiles"))
    {
        return Err(invalid("请选择地图图层和 .mbtiles 保存位置"));
    }
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temp = tempfile::NamedTempFile::new_in(parent)?;
    let mut conn = Connection::open(temp.path())?;
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB NOT NULL,
            PRIMARY KEY (zoom_level, tile_column, tile_row)) WITHOUT ROWID;
         CREATE TABLE photofactory_overview_tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER,
            PRIMARY KEY (zoom_level, tile_column, tile_row)) WITHOUT ROWID;",
    )?;
    let mut credits = std::collections::BTreeSet::new();
    let packages = package_paths(&offline_dir.join(layer))?;
    let mut tile_count = copy_imported_tiles(&tx, &packages, false, &mut credits)?;
    let cache = if layer == "satellite" {
        cache_dir.join("satellite")
    } else {
        cache_dir.to_path_buf()
    };
    let before = tile_count;
    for entry in walkdir::WalkDir::new(&cache)
        .min_depth(3)
        .max_depth(3)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(coords) = entry
            .path()
            .strip_prefix(&cache)
            .ok()
            .and_then(cached_tile_coords)
        else {
            continue;
        };
        // Online cache eviction can remove a tile between listing and opening it.
        let file = match fs::File::open(entry.path()) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_TILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if export_tile(&tx, coords, &bytes)? {
            tile_count += 1;
        }
    }
    if tile_count > before {
        credits.insert(
            if layer == "satellite" {
                "Tiles © Esri"
            } else {
                "© OpenStreetMap contributors"
            }
            .into(),
        );
    }
    tile_count += copy_imported_tiles(&tx, &packages, true, &mut credits)?;
    if tile_count == 0 {
        return Err(invalid("此图层还没有缓存或已导入的瓦片"));
    }
    let (min_zoom, max_zoom): (u32, u32) = tx.query_row(
        "SELECT MIN(zoom_level),MAX(zoom_level) FROM tiles",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // Use the most detailed tiles for the import's initial view. A cached
    // world overview tile should not send a local export back to the world view.
    let (west, south, east, north): (u32, u32, u32, u32) = tx.query_row(
        "SELECT MIN(tile_column),MIN(tile_row),MAX(tile_column)+1,MAX(tile_row)+1 FROM tiles WHERE zoom_level=?1",
        [max_zoom], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let edge = f64::from(1u32 << max_zoom);
    let lon = |x: u32| 360.0 * f64::from(x) / edge - 180.0;
    let lat = |y: u32| {
        ((2.0 * f64::from(y) / edge - 1.0) * std::f64::consts::PI)
            .sinh()
            .atan()
            .to_degrees()
    };
    let bounds = format!("{},{},{},{}", lon(west), lat(south), lon(east), lat(north));
    let layer_name = if layer == "satellite" {
        "卫星实景地图"
    } else {
        "标准地图"
    };
    let metadata = [
        ("name", format!("{name} · {layer_name}")),
        ("type", "baselayer".into()),
        ("version", "1.3".into()),
        ("format", "webp".into()),
        ("photofactory_layer", layer.into()),
        ("minzoom", min_zoom.to_string()),
        ("maxzoom", max_zoom.to_string()),
        ("bounds", bounds),
        (
            "attribution",
            credits.into_iter().collect::<Vec<_>>().join(" · "),
        ),
    ];
    for (key, value) in metadata {
        tx.execute("INSERT INTO metadata VALUES (?1,?2)", (key, value))?;
    }
    tx.commit()?;
    drop(conn);
    let bytes = temp.as_file().metadata()?.len();
    if bytes > MAX_PACKAGE_BYTES {
        return Err(invalid("导出的地图包超过 32 GiB"));
    }
    temp.persist(destination).map_err(|error| error.error)?;
    Ok(ExportedMap { tile_count, bytes })
}

pub fn export_selection(
    offline_dir: &Path,
    cache_dir: &Path,
    destination: &Path,
    name: &str,
    layer: &str,
) -> AppResult<ExportedMap> {
    if layer != "both" {
        return export_package(offline_dir, cache_dir, destination, name, layer);
    }
    if !destination
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pfmap"))
    {
        return Err(invalid("双图层导出请选择 .pfmap 保存位置"));
    }
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let work = tempfile::tempdir_in(parent)?;
    let paths = LAYERS.map(|layer| work.path().join(format!("{layer}.mbtiles")));
    let mut tile_count = 0;
    let mut lengths = [0; 2];
    for (index, layer) in LAYERS.into_iter().enumerate() {
        let result = export_package(offline_dir, cache_dir, &paths[index], name, layer).map_err(
            |error| {
                invalid(&format!(
                    "{}导出失败。{error}",
                    if layer == "standard" {
                        "标准地图"
                    } else {
                        "卫星实景地图"
                    }
                ))
            },
        )?;
        tile_count += result.tile_count;
        lengths[index] = result.bytes;
    }
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    output.write_all(BUNDLE_MAGIC)?;
    for length in lengths {
        output.write_all(&length.to_le_bytes())?;
    }
    for path in paths {
        std::io::copy(&mut fs::File::open(path)?, &mut output)?;
    }
    let bytes = output.as_file().metadata()?.len();
    output.persist(destination).map_err(|error| error.error)?;
    Ok(ExportedMap { tile_count, bytes })
}

#[cfg(test)]
pub(crate) fn write_fixture(path: &Path, format: &str) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
            PRIMARY KEY (zoom_level, tile_column, tile_row)) WITHOUT ROWID;
         INSERT INTO metadata VALUES ('name','上海'),('bounds','120,30,122,32'),
            ('photofactory_layer','satellite'),('attribution','Test imagery');",
    ).unwrap();
    conn.execute("INSERT INTO metadata VALUES ('format',?1)", [format])
        .unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(16, 16)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    // At zoom 3 the XYZ row 2 is TMS row 5.
    conn.execute("INSERT INTO tiles VALUES (3,6,5,?1)", [png.into_inner()])
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overview_is_fallback_and_export_preserves_tile_priority() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("overview.mbtiles");
        write_fixture(&source, "png");
        let conn = Connection::open(&source).unwrap();
        conn.execute_batch(
            "UPDATE metadata SET value='NASA Earthdata / GIBS — Blue Marble' WHERE name='attribution';
             INSERT INTO tiles SELECT zoom_level,tile_column,4,tile_data FROM tiles;",
        )
        .unwrap();
        drop(conn);
        let offline = temp.path().join("offline");
        import_package(&source, &offline).unwrap();
        let original = tile_options(&offline, "satellite", 3, 6, 2).unwrap();
        assert!(original.detail.is_none());
        assert!(original.overview.is_some());

        let cache = temp.path().join("tiles");
        let column = cache.join("satellite/3/6");
        fs::create_dir_all(&column).unwrap();
        image::DynamicImage::new_rgb8(32, 32)
            .save(column.join("2.jpg"))
            .unwrap();
        let exported = temp.path().join("mixed.mbtiles");
        export_package(&offline, &cache, &exported, "相册", "satellite").unwrap();
        let home = temp.path().join("home");
        import_package(&exported, &home).unwrap();
        let detail = tile_options(&home, "satellite", 3, 6, 2).unwrap();
        assert!(detail.overview.is_none());
        let url = detail.detail.unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.strip_prefix("data:image/webp;base64,").unwrap())
            .unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 32);
        let overview = tile_options(&home, "satellite", 3, 6, 3).unwrap();
        assert!(overview.detail.is_none());
        assert!(overview.overview.is_some());
    }

    #[test]
    fn imported_pack_survives_unplugging_and_reads_tms_row() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("公司地图.MBTILES");
        write_fixture(&source, "png");
        let dir = temp.path().join(".pf/maps/offline");
        let imported = import_package(&source, &dir).unwrap();
        fs::remove_file(source).unwrap();
        let list = list_packages(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, imported.id);
        assert_eq!(list[0].name, "上海");
        assert_eq!(list[0].bounds, Some([120.0, 30.0, 122.0, 32.0]));
        assert_eq!((list[0].min_zoom, list[0].max_zoom), (3, 3));
        let url = tile_data_url(&dir, "satellite", 3, 6, 2).unwrap().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 16);
        assert!(tile_data_url(&dir, "satellite", 3, 6, 5).unwrap().is_none());
        assert!(tile_data_url(&dir, "standard", 3, 6, 2).unwrap().is_none());
    }

    #[test]
    fn export_merges_cache_and_imports_into_a_reimportable_layer() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("imported.mbtiles");
        write_fixture(&source, "png");
        let offline = temp.path().join("offline");
        import_package(&source, &offline).unwrap();
        let cache = temp.path().join("tiles");
        let satellite = cache.join("satellite/3/6");
        fs::create_dir_all(&satellite).unwrap();
        let cached = image::DynamicImage::new_rgb8(32, 32);
        cached.save(satellite.join("2.jpg")).unwrap(); // overlaps the imported PNG
        cached.save(satellite.join("3.jpg")).unwrap();
        fs::write(satellite.join("4.jpg"), b"broken cached tile").unwrap();
        let standard = cache.join("3/6");
        fs::create_dir_all(&standard).unwrap();
        cached.save(standard.join("1.png")).unwrap();

        let exported = temp.path().join("导出地图.mbtiles");
        assert_eq!(
            export_package(&offline, &cache, &exported, "相册", "satellite")
                .unwrap()
                .tile_count,
            2
        );
        let home = temp.path().join("home");
        let info = import_package(&exported, &home).unwrap();
        assert_eq!(info.layer, "satellite");
        assert!(info.attribution.unwrap().contains("Test imagery"));
        for (y, width) in [(2, 16), (3, 32)] {
            let url = tile_data_url(&home, "satellite", 3, 6, y).unwrap().unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(url.strip_prefix("data:image/webp;base64,").unwrap())
                .unwrap();
            assert_eq!(image::load_from_memory(&bytes).unwrap().width(), width);
        }
        assert!(tile_data_url(&home, "satellite", 3, 6, 1)
            .unwrap()
            .is_none());
        assert!(tile_data_url(&home, "satellite", 3, 6, 4)
            .unwrap()
            .is_none());

        let standard_export = temp.path().join("standard.mbtiles");
        assert_eq!(
            export_package(&offline, &cache, &standard_export, "相册", "standard")
                .unwrap()
                .tile_count,
            1
        );
        assert_eq!(
            import_package(&standard_export, &home).unwrap().layer,
            "standard"
        );
        assert!(tile_data_url(&home, "standard", 3, 6, 1).unwrap().is_some());
    }

    #[test]
    fn dual_export_keeps_layers_separate_and_rejects_a_truncated_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("tiles");
        let offline = dir.path().join("offline");
        let home = dir.path().join("home");
        let bundle = dir.path().join("双图层.pfmap");
        for (folder, row, width) in [
            (cache.join("3/6"), 1, 16),
            (cache.join("satellite/3/6"), 2, 32),
        ] {
            fs::create_dir_all(&folder).unwrap();
            image::DynamicImage::new_rgb8(width, width)
                .save(folder.join(format!("{row}.png")))
                .unwrap();
        }
        assert_eq!(
            export_selection(&offline, &cache, &bundle, "测试", "both")
                .unwrap()
                .tile_count,
            2
        );
        let truncated = dir.path().join("truncated.pfmap");
        let mut bytes = fs::read(&bundle).unwrap();
        bytes.pop();
        fs::write(&truncated, bytes).unwrap();
        assert!(import_packages(&[bundle.clone(), truncated], &home).is_err());
        assert!(list_packages(&home).unwrap().is_empty());
        let maps = import_packages(&[bundle], &home).unwrap();
        assert_eq!(
            maps.iter()
                .map(|map| map.layer.as_str())
                .collect::<Vec<_>>(),
            LAYERS
        );
        assert!(tile_data_url(&home, "standard", 3, 6, 1).unwrap().is_some());
        assert!(tile_data_url(&home, "satellite", 3, 6, 2)
            .unwrap()
            .is_some());
        assert!(tile_data_url(&home, "standard", 3, 6, 2).unwrap().is_none());
        assert!(tile_data_url(&home, "satellite", 3, 6, 1)
            .unwrap()
            .is_none());
    }

    #[test]
    fn invalid_packages_are_not_published() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("offline");
        let vector = temp.path().join("vector.mbtiles");
        write_fixture(&vector, "pbf");
        assert!(import_package(&vector, &dir).is_err());
        let broken = temp.path().join("broken.mbtiles");
        fs::write(&broken, b"not sqlite").unwrap();
        assert!(import_package(&broken, &dir).is_err());
        assert!(list_packages(&dir).unwrap().is_empty());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }
}

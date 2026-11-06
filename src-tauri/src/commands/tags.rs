// src-tauri/src/commands/tags.rs
use std::path::Path;
use tauri::State;

use crate::commands::project::{get_conn, AppState};
use crate::db::classification_dao;
use crate::db::manual_tag_dao;
use crate::db::photo_dao;
use crate::error::{AppError, AppResult};
use crate::models::ManualTag;
use crate::thumbnail::generator;

#[derive(Debug, serde::Serialize)]
pub struct AiTagSummary {
    label: String,
    category: String,
    source: String,
    photo_count: i64,
    average_confidence: f64,
}

#[derive(Debug, serde::Serialize)]
pub struct AiTagGroup {
    category: String,
    labels: Vec<AiTagSummary>,
}

#[tauri::command]
pub async fn cmd_get_ai_tag_groups(state: State<'_, AppState>) -> AppResult<Vec<AiTagGroup>> {
    let conn = get_conn(state)?;
    get_ai_tag_groups(&conn)
}

fn get_ai_tag_groups(conn: &rusqlite::Connection) -> AppResult<Vec<AiTagGroup>> {
    let mut statement = conn.prepare(
        "SELECT COALESCE(NULLIF(TRIM(ac.category), ''), '其他'), ac.label,
                COALESCE(ac.tag_type, ac.label_type, 'ai_scene'),
                COUNT(DISTINCT ac.photo_id), AVG(ac.confidence)
         FROM ai_classifications ac
         JOIN photos p ON p.id = ac.photo_id
         WHERE p.deleted = 0
         GROUP BY 1, ac.label, 3
         ORDER BY COUNT(DISTINCT ac.photo_id) DESC, ac.label",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut grouped = std::collections::BTreeMap::<String, Vec<AiTagSummary>>::new();
    for (raw_category, raw_label, source, photo_count, average_confidence) in rows {
        let category = match source.as_str() {
            "ai_scene" => "场景".to_string(),
            "ai_semantic" => raw_category,
            "geo_location" => "地点".to_string(),
            "time_period" => "时间".to_string(),
            "event" => "事件".to_string(),
            "device" => "设备".to_string(),
            "tone" | "rule_tone" => "色彩与氛围".to_string(),
            "rule_time_period" | "rule_season" => "时间".to_string(),
            "rule_face_count" => "人物".to_string(),
            "rule_weather" => "天气".to_string(),
            _ => raw_category,
        };
        let label = if source == "ai_scene" {
            crate::tags::places365_cn::translate_label(&raw_label).to_string()
        } else {
            raw_label
        };
        grouped
            .entry(category.clone())
            .or_default()
            .push(AiTagSummary {
                label,
                category,
                source,
                photo_count,
                average_confidence,
            });
    }
    let preferred = [
        "人物",
        "活动",
        "动物",
        "食物",
        "交通",
        "物品",
        "自然",
        "天气",
        "建筑",
        "场景",
        "地点",
        "时间",
        "事件",
        "设备",
        "色彩与氛围",
        "其他",
    ];
    let mut groups = Vec::new();
    for category in preferred {
        if let Some(labels) = grouped.remove(category) {
            groups.push(AiTagGroup {
                category: category.into(),
                labels,
            });
        }
    }
    groups.extend(
        grouped
            .into_iter()
            .map(|(category, labels)| AiTagGroup { category, labels }),
    );
    Ok(groups)
}

#[cfg(test)]
mod ai_tag_group_tests {
    use super::*;
    use crate::db::schema::CREATE_TABLES;

    #[test]
    fn groups_current_ai_labels_by_category_and_source() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        conn.execute_batch(
            "ALTER TABLE ai_classifications ADD COLUMN label_type TEXT DEFAULT 'ai_scene';
             ALTER TABLE ai_classifications ADD COLUMN tag_type TEXT DEFAULT 'ai_scene';
             INSERT INTO photos (id,path,filename,file_size,file_mtime,imported_at,deleted)
             VALUES (1,'/one.jpg','one.jpg',10,1,1,0),
                    (2,'/deleted.jpg','deleted.jpg',10,1,1,1);
             INSERT INTO ai_classifications
               (photo_id,category,label,confidence,label_type,tag_type)
             VALUES (1,'人物','合影',0.82,'ai_semantic','ai_semantic'),
                    (1,'scene','b_beach',0.91,'ai_scene','ai_scene'),
                    (2,'动物','狗',0.95,'ai_semantic','ai_semantic');",
        )
        .unwrap();

        let groups = get_ai_tag_groups(&conn).unwrap();
        let people = groups
            .iter()
            .find(|group| group.category == "人物")
            .unwrap();
        assert_eq!(people.labels[0].label, "合影");
        assert_eq!(people.labels[0].photo_count, 1);
        let scenes = groups
            .iter()
            .find(|group| group.category == "场景")
            .unwrap();
        assert_eq!(scenes.labels[0].label, "海滩");
        assert!(groups.iter().all(|group| group.category != "动物"));
    }
}

#[tauri::command]
pub async fn cmd_get_manual_tags(state: State<'_, AppState>) -> AppResult<Vec<ManualTag>> {
    manual_tag_dao::get_all(&get_conn(state)?)
}

#[tauri::command]
pub async fn cmd_get_photo_manual_tags(
    photo_id: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<ManualTag>> {
    manual_tag_dao::get_for_photo(&get_conn(state)?, photo_id)
}

#[tauri::command]
pub async fn cmd_create_manual_tag(
    name: String,
    color: String,
    state: State<'_, AppState>,
) -> AppResult<i64> {
    manual_tag_dao::create(&get_conn(state)?, &name, &color)
}

#[tauri::command]
pub async fn cmd_update_manual_tag(
    tag_id: i64,
    name: String,
    color: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    manual_tag_dao::update(&get_conn(state)?, tag_id, &name, &color)
}

#[tauri::command]
pub async fn cmd_delete_manual_tag(tag_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    manual_tag_dao::delete(&get_conn(state)?, tag_id)
}

#[tauri::command]
pub async fn cmd_set_photo_manual_tags(
    photo_id: i64,
    tag_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    manual_tag_dao::set_for_photo(&get_conn(state)?, photo_id, &tag_ids)
}

#[tauri::command]
pub async fn cmd_get_all_labels(state: State<'_, AppState>) -> AppResult<Vec<(String, i64)>> {
    let conn = get_conn(state.clone())?;
    let raw = classification_dao::get_all_labels(&conn)?;
    Ok(crate::tags::places365_cn::translate_labels(raw))
}

#[tauri::command]
pub async fn cmd_rename_classification_label(
    state: State<'_, AppState>,
    old_label: String,
    new_label: String,
) -> AppResult<()> {
    let conn = get_conn(state.clone())?;
    classification_dao::rename_label(&conn, &old_label, &new_label)
}

/// Get the thumbnail path for the first photo with a given label.
#[tauri::command]
pub async fn cmd_get_label_preview(label: String, state: State<'_, AppState>) -> AppResult<String> {
    let conn = get_conn(state.clone())?;
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };

    let photo_id = classification_dao::get_label_preview_photo_id(&conn, &label)?
        .ok_or_else(|| AppError::NotFound(format!("No photos with label: {}", label)))?;

    let photo = photo_dao::get_photo_by_id(&conn, photo_id)?
        .ok_or_else(|| AppError::NotFound(format!("Photo {} not found", photo_id)))?;

    let out_dir = project.small_thumbnails_path();

    // Check both sharded and legacy flat paths
    if let Some(thumb_path) = generator::find_thumbnail_path(&photo.path, &out_dir) {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    // Generate on demand (writes to new sharded path)
    generator::generate_small_thumbnail(Path::new(&photo.path), &out_dir)?;
    Ok(generator::thumbnail_path_for(&photo.path, &out_dir)
        .to_string_lossy()
        .to_string())
}

/// Get the full label hierarchy as a tree of LabelNode.
#[tauri::command]
pub async fn cmd_get_label_hierarchy(
    state: State<'_, AppState>,
) -> AppResult<Vec<classification_dao::LabelNode>> {
    let conn = get_conn(state.clone())?;
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let thumbs_dir = project.small_thumbnails_path();
    let nodes = classification_dao::get_label_hierarchy(&conn)?;
    Ok(nodes
        .into_iter()
        .map(|mut node| {
            node.label = crate::tags::places365_cn::translate_label(&node.label).to_string();
            node.children = node
                .children
                .into_iter()
                .map(|mut child| {
                    child.label =
                        crate::tags::places365_cn::translate_label(&child.label).to_string();
                    // The DAO returns the source photo path. Resolve it to an already-built
                    // thumbnail here so the UI does not issue one IPC/database query per tag.
                    child.preview_thumbnail = child
                        .preview_thumbnail
                        .as_deref()
                        .and_then(|path| generator::find_thumbnail_path(path, &thumbs_dir))
                        .map(|path| path.to_string_lossy().to_string());
                    child
                })
                .collect();
            node.preview_thumbnail = node
                .preview_thumbnail
                .as_deref()
                .and_then(|path| generator::find_thumbnail_path(path, &thumbs_dir))
                .map(|path| path.to_string_lossy().to_string())
                .or_else(|| {
                    node.children
                        .iter()
                        .find_map(|child| child.preview_thumbnail.clone())
                });
            node
        })
        .collect())
}

/// Get labels filtered by tag_type.
#[tauri::command]
pub async fn cmd_get_labels_by_type(
    tag_type: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<(String, i64)>> {
    let conn = get_conn(state.clone())?;
    classification_dao::get_labels_by_type(&conn, &tag_type)
}

/// Rebuild the label hierarchy (currently a no-op — hierarchy is computed at query time).
#[tauri::command]
pub async fn cmd_rebuild_label_hierarchy() -> AppResult<()> {
    Ok(())
}

/// Get the count of photos with a given label.
#[tauri::command]
pub async fn cmd_get_label_photo_count(
    label: String,
    state: State<'_, AppState>,
) -> AppResult<i64> {
    let conn = get_conn(state.clone())?;
    classification_dao::get_label_photo_count(&conn, &label)
}

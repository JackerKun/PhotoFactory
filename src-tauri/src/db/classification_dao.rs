// src-tauri/src/db/classification_dao.rs
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::error::AppResult;
use crate::models::AiClassification;

pub fn insert_classification(conn: &rusqlite::Connection, c: &AiClassification) -> AppResult<()> {
    conn.execute(
        "INSERT INTO ai_classifications (photo_id, category, label, confidence)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(photo_id, label) DO UPDATE SET
           category = excluded.category, confidence = excluded.confidence",
        params![c.photo_id, c.category, c.label, c.confidence],
    )?;
    Ok(())
}

pub fn insert_classifications_batch(
    conn: &rusqlite::Connection,
    items: &[AiClassification],
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for item in items {
        insert_classification(&tx, item)?;
    }
    tx.commit()?;
    Ok(())
}

/// Insert a classification with an explicit tag_type.
pub fn insert_classification_with_type(
    conn: &rusqlite::Connection,
    c: &AiClassification,
    tag_type: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(photo_id, label) DO UPDATE SET
           category = excluded.category, confidence = excluded.confidence, tag_type = excluded.tag_type",
        params![c.photo_id, c.category, c.label, c.confidence, tag_type],
    )?;
    Ok(())
}

/// Batch insert classifications with an explicit tag_type.
pub fn insert_classifications_batch_with_type(
    conn: &rusqlite::Connection,
    items: &[AiClassification],
    tag_type: &str,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for item in items {
        insert_classification_with_type(&tx, item, tag_type)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn get_classifications_for_photo(
    conn: &rusqlite::Connection,
    photo_id: i64,
) -> AppResult<Vec<AiClassification>> {
    let mut stmt = conn.prepare("SELECT id, photo_id, category, label, confidence FROM ai_classifications WHERE photo_id = ? ORDER BY confidence DESC")?;
    let rows = stmt
        .query_map([photo_id], |r| {
            Ok(AiClassification {
                id: r.get(0)?,
                photo_id: r.get(1)?,
                category: r.get(2)?,
                label: r.get(3)?,
                confidence: r.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn get_all_labels(conn: &rusqlite::Connection) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT label, COUNT(*) as cnt FROM ai_classifications GROUP BY label ORDER BY cnt DESC",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Get labels filtered by tag_type.
pub fn get_labels_by_type(
    conn: &rusqlite::Connection,
    tag_type: &str,
) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT label, COUNT(*) as cnt FROM ai_classifications WHERE tag_type = ?1 GROUP BY label ORDER BY cnt DESC"
    )?;
    let rows = stmt
        .query_map([tag_type], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Get all unique labels with their photo counts and a preview photo path
/// (the path of the photo with the highest confidence for that label).
pub fn get_labels_with_previews(
    conn: &rusqlite::Connection,
) -> AppResult<Vec<(String, i64, Option<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT ac.label, COUNT(*) as cnt,
                (SELECT p.path FROM ai_classifications ac2
                 JOIN photos p ON p.id = ac2.photo_id
                 WHERE ac2.label = ac.label
                 ORDER BY ac2.confidence DESC LIMIT 1)
         FROM ai_classifications ac
         GROUP BY ac.label
         ORDER BY cnt DESC",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn rename_label(
    conn: &rusqlite::Connection,
    old_label: &str,
    new_label: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_classifications SET label = ?1 WHERE label = ?2",
        params![new_label, old_label],
    )?;
    Ok(())
}

/// Get the first photo_id for a given label (for thumbnail preview).
pub fn get_label_preview_photo_id(
    conn: &rusqlite::Connection,
    label: &str,
) -> AppResult<Option<i64>> {
    let mut stmt =
        conn.prepare("SELECT photo_id FROM ai_classifications WHERE label = ?1 LIMIT 1")?;
    stmt.query_row([label], |r| r.get(0))
        .optional()
        .map_err(|e| e.into())
}

/// Get the count of photos with a given label.
pub fn get_label_photo_count(conn: &rusqlite::Connection, label: &str) -> AppResult<i64> {
    conn.query_row(
        "SELECT COUNT(DISTINCT photo_id) FROM ai_classifications WHERE label = ?1",
        [label],
        |r| r.get(0),
    )
    .map_err(|e| e.into())
}

// ---------------------------------------------------------------------------
// Label hierarchy
// ---------------------------------------------------------------------------

/// A node in the label hierarchy tree.
#[derive(Debug, Clone, Serialize)]
pub struct LabelNode {
    pub id: i64,
    pub label: String,
    pub parent_id: Option<i64>,
    pub label_type: String,
    pub count: i64,
    pub preview_thumbnail: Option<String>,
    pub children: Vec<LabelNode>,
}

/// Get the full label hierarchy from the database, grouping leaf labels
/// under their parent categories using the static parent mapping.
pub fn get_label_hierarchy(conn: &rusqlite::Connection) -> AppResult<Vec<LabelNode>> {
    // Gather all leaf labels with counts and preview paths (only ai_scene labels)
    let mut stmt = conn.prepare(
        "SELECT ac.label, ac.label_type, COUNT(*) as cnt,
                (SELECT p.path FROM ai_classifications ac2
                 JOIN photos p ON p.id = ac2.photo_id
                 WHERE ac2.label = ac.label
                 ORDER BY ac2.confidence DESC LIMIT 1)
         FROM ai_classifications ac
         WHERE ac.label_type = 'ai_scene'
         GROUP BY ac.label
         ORDER BY cnt DESC",
    )?;
    let rows: Vec<(String, String, i64, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .filter_map(|r| r.ok())
        .collect();

    // Apply parent mapping: create parent nodes for categories that have leaves
    let parent_map = get_label_parents();
    let mut parent_counts: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    let mut leaf_nodes: Vec<LabelNode> = Vec::new();
    let mut next_id: i64 = 1;

    for (label, label_type, count, preview) in rows {
        if let Some(parent_label) = parent_map.get(&label) {
            *parent_counts.entry(parent_label.clone()).or_insert(0) += count;
            leaf_nodes.push(LabelNode {
                id: next_id,
                label,
                parent_id: Some(-1), // placeholder, resolved below
                label_type,
                count,
                preview_thumbnail: preview,
                children: vec![],
            });
            next_id += 1;
        } else {
            // Unknown label — keep as root
            leaf_nodes.push(LabelNode {
                id: next_id,
                label,
                parent_id: None,
                label_type,
                count,
                preview_thumbnail: preview,
                children: vec![],
            });
            next_id += 1;
        }
    }

    // Create parent category nodes
    let mut all_nodes = leaf_nodes;
    for (parent_label, parent_count) in &parent_counts {
        // Only create parent if there are children
        if *parent_count > 0 {
            all_nodes.push(LabelNode {
                id: next_id,
                label: parent_label.clone(),
                parent_id: None,
                label_type: "ai_scene".to_string(),
                count: *parent_count,
                preview_thumbnail: None,
                children: vec![],
            });
            // Update leaf nodes to point to this parent
            let parent_id = next_id;
            for node in &mut all_nodes {
                if node.parent_id == Some(-1)
                    && parent_map.get(&node.label).map(|p| p.as_str())
                        == Some(parent_label.as_str())
                {
                    node.parent_id = Some(parent_id);
                }
            }
            next_id += 1;
        }
    }

    Ok(build_label_hierarchy(all_nodes))
}

/// Build a hierarchy tree from flat label nodes using parent mapping.
/// Parent category counts are the SUM of their children's counts.
pub fn build_label_hierarchy(leaf_nodes: Vec<LabelNode>) -> Vec<LabelNode> {
    use std::collections::HashMap;

    let mut nodes_by_id: HashMap<i64, LabelNode> = HashMap::new();
    let mut children_map: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut roots: Vec<i64> = Vec::new();

    // First pass: index all nodes and determine parent-child relationships
    for node in leaf_nodes {
        let id = node.id;
        if let Some(parent_id) = node.parent_id {
            children_map.entry(parent_id).or_default().push(id);
        } else {
            roots.push(id);
        }
        nodes_by_id.insert(id, node);
    }

    // Compute parent counts as sum of children counts
    fn compute_count(
        id: i64,
        nodes: &mut HashMap<i64, LabelNode>,
        children: &HashMap<i64, Vec<i64>>,
    ) -> i64 {
        if let Some(child_ids) = children.get(&id) {
            let sum: i64 = child_ids
                .iter()
                .map(|cid| compute_count(*cid, nodes, children))
                .sum();
            if let Some(node) = nodes.get_mut(&id) {
                node.count = sum;
            }
            sum
        } else {
            nodes.get(&id).map(|n| n.count).unwrap_or(0)
        }
    }

    for root_id in &roots {
        compute_count(*root_id, &mut nodes_by_id, &children_map);
    }

    // Build the tree
    fn build_tree(
        id: i64,
        nodes: &mut HashMap<i64, LabelNode>,
        children: &HashMap<i64, Vec<i64>>,
    ) -> LabelNode {
        let mut node = nodes.remove(&id).unwrap();
        let child_ids = children.get(&id).cloned().unwrap_or_default();
        let existing_children: Vec<i64> = child_ids
            .into_iter()
            .filter(|cid| nodes.contains_key(cid))
            .collect();
        node.children = existing_children
            .into_iter()
            .map(|cid| build_tree(cid, nodes, children))
            .collect();
        // Sort children by count descending
        node.children.sort_by(|a, b| b.count.cmp(&a.count));
        node
    }

    let existing_roots: Vec<i64> = roots
        .into_iter()
        .filter(|rid| nodes_by_id.contains_key(rid))
        .collect();

    existing_roots
        .into_iter()
        .map(|rid| build_tree(rid, &mut nodes_by_id, &children_map))
        .collect()
}

/// Static mapping of Places365 scene labels to top-level Chinese categories.
/// Covers ~80 common scene labels mapped to 8 parent categories.
pub fn get_label_parents() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();

    // 自然 (Nature)
    for label in &[
        "mountain",
        "valley",
        "cliff",
        "canyon",
        "cave",
        "glacier",
        "forest",
        "woodland",
        "tree",
        "jungle",
        "ocean",
        "sea",
        "beach",
        "coast",
        "waterfall",
        "river",
        "lake",
        "pond",
        "desert",
        "sand",
        "dune",
        "snowfield",
        "sky",
        "cloud",
        "sunset",
        "sunrise",
        "flower",
        "garden",
        "meadow",
        "field",
        "grass",
    ] {
        map.insert(label.to_string(), "自然".to_string());
    }

    // 建筑 (Architecture)
    for label in &[
        "building",
        "skyscraper",
        "tower",
        "castle",
        "palace",
        "temple",
        "church",
        "mosque",
        "pagoda",
        "monument",
        "house",
        "cottage",
        "cabin",
        "apartment",
        "hotel",
        "bridge",
        "dam",
        "wall",
        "fence",
        "gate",
        "door",
        "roof",
        "balcony",
        "terrace",
        "patio",
        "porch",
        "room",
        "bedroom",
        "bathroom",
        "kitchen",
        "living_room",
        "dining_room",
        "office",
        "classroom",
        "library",
        "museum",
        "theater",
        "restaurant",
        "corridor",
        "hallway",
        "staircase",
        "attic",
        "basement",
        "garage",
        "shed",
        "barn",
        "architecture",
        "skyscraper",
        "indoor",
        "outdoor",
    ] {
        map.insert(label.to_string(), "建筑".to_string());
    }

    // 人物 (People)
    for label in &[
        "person",
        "crowd",
        "audience",
        "group",
        "stadium",
        "amusement_park",
        "playground",
    ] {
        map.insert(label.to_string(), "人物".to_string());
    }

    // 生活 (Life)
    for label in &[
        "market",
        "bazaar",
        "shop",
        "store",
        "supermarket",
        "street",
        "alley",
        "sidewalk",
        "plaza",
        "square",
        "park",
        "picnic",
        "campsite",
        "food",
        "restaurant",
        "cafe",
        "bar",
        "pub",
        "home",
        "living_room",
        "bedroom",
        "kitchen",
        "party",
        "wedding",
        "ceremony",
    ] {
        map.insert(label.to_string(), "生活".to_string());
    }

    // 交通 (Transportation)
    for label in &[
        "highway",
        "road",
        "freeway",
        "motorway",
        "intersection",
        "railway",
        "train_station",
        "airport",
        "hangar",
        "runway",
        "harbor",
        "dock",
        "pier",
        "marina",
        "gas_station",
        "parking_lot",
        "bus_station",
    ] {
        map.insert(label.to_string(), "交通".to_string());
    }

    // 运动 (Sports)
    for label in &[
        "sports_field",
        "football_field",
        "baseball_field",
        "tennis_court",
        "basketball_court",
        "swimming_pool",
        "ski_slope",
        "ice_rink",
        "gymnasium",
        "playground",
    ] {
        map.insert(label.to_string(), "运动".to_string());
    }

    // 动物 (Animals)
    for label in &[
        "zoo",
        "aquarium",
        "farm",
        "pasture",
        "wilderness",
        "savanna",
        "tundra",
    ] {
        map.insert(label.to_string(), "动物".to_string());
    }

    // 其他 (Other) - anything not mapped above defaults to this
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn new_in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE photos (
                id INTEGER PRIMARY KEY, path TEXT, filename TEXT, file_size INTEGER,
                file_mtime INTEGER, width INTEGER, height INTEGER, format TEXT,
                taken_at INTEGER, camera_make TEXT, camera_model TEXT, latitude REAL,
                longitude REAL, orientation INTEGER DEFAULT 1, thumbnail_status INTEGER DEFAULT 0,
                ai_status INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0,
                exposure_time TEXT, f_number TEXT, iso INTEGER, imported_at INTEGER
            );
            CREATE TABLE ai_classifications (
                id INTEGER PRIMARY KEY, photo_id INTEGER, category TEXT, label TEXT,
                confidence REAL, parent_id INTEGER, label_type TEXT DEFAULT 'ai_scene',
                tag_type TEXT DEFAULT 'ai_scene', UNIQUE(photo_id, label)
            );"
        ).unwrap();
        conn
    }

    #[test]
    fn test_insert_and_get_classifications_for_photo() {
        let conn = new_in_memory_db();
        let c = AiClassification {
            id: None,
            photo_id: 1,
            category: "scene".into(),
            label: "mountain".into(),
            confidence: 0.95,
        };
        insert_classification(&conn, &c).unwrap();
        let results = get_classifications_for_photo(&conn, 1).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].label, "mountain");
    }

    #[test]
    fn test_insert_classifications_batch() {
        let conn = new_in_memory_db();
        let items = vec![
            AiClassification {
                id: None,
                photo_id: 1,
                category: "scene".into(),
                label: "mountain".into(),
                confidence: 0.95,
            },
            AiClassification {
                id: None,
                photo_id: 1,
                category: "scene".into(),
                label: "forest".into(),
                confidence: 0.85,
            },
        ];
        insert_classifications_batch(&conn, &items).unwrap();
        let results = get_classifications_for_photo(&conn, 1).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_insert_classification_with_type() {
        let conn = new_in_memory_db();
        let c = AiClassification {
            id: None,
            photo_id: 1,
            category: "scene".into(),
            label: "mountain".into(),
            confidence: 0.95,
        };
        insert_classification_with_type(&conn, &c, "geo_location").unwrap();
        let labels = get_labels_by_type(&conn, "geo_location").unwrap();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].0, "mountain");

        let other_labels = get_labels_by_type(&conn, "ai_scene").unwrap();
        assert_eq!(other_labels.len(), 0);
    }

    #[test]
    fn test_insert_classifications_batch_with_type() {
        let conn = new_in_memory_db();
        let items = vec![
            AiClassification {
                id: None,
                photo_id: 1,
                category: "scene".into(),
                label: "beach".into(),
                confidence: 0.90,
            },
            AiClassification {
                id: None,
                photo_id: 2,
                category: "scene".into(),
                label: "ocean".into(),
                confidence: 0.88,
            },
        ];
        insert_classifications_batch_with_type(&conn, &items, "event").unwrap();
        let labels = get_labels_by_type(&conn, "event").unwrap();
        assert_eq!(labels.len(), 2);
    }

    #[test]
    fn test_get_all_labels() {
        let conn = new_in_memory_db();
        let items = vec![
            AiClassification {
                id: None,
                photo_id: 1,
                category: "scene".into(),
                label: "mountain".into(),
                confidence: 0.9,
            },
            AiClassification {
                id: None,
                photo_id: 2,
                category: "scene".into(),
                label: "mountain".into(),
                confidence: 0.8,
            },
            AiClassification {
                id: None,
                photo_id: 3,
                category: "scene".into(),
                label: "beach".into(),
                confidence: 0.7,
            },
        ];
        insert_classifications_batch(&conn, &items).unwrap();
        let labels = get_all_labels(&conn).unwrap();
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].0, "mountain");
        assert_eq!(labels[0].1, 2);
        assert_eq!(labels[1].0, "beach");
        assert_eq!(labels[1].1, 1);
    }

    #[test]
    fn test_get_labels_by_type() {
        let conn = new_in_memory_db();
        let c1 = AiClassification {
            id: None,
            photo_id: 1,
            category: "scene".into(),
            label: "mountain".into(),
            confidence: 0.9,
        };
        let c2 = AiClassification {
            id: None,
            photo_id: 2,
            category: "scene".into(),
            label: "beach".into(),
            confidence: 0.8,
        };
        insert_classification_with_type(&conn, &c1, "ai_scene").unwrap();
        insert_classification_with_type(&conn, &c2, "event").unwrap();

        let ai_labels = get_labels_by_type(&conn, "ai_scene").unwrap();
        assert_eq!(ai_labels.len(), 1);
        assert_eq!(ai_labels[0].0, "mountain");

        let event_labels = get_labels_by_type(&conn, "event").unwrap();
        assert_eq!(event_labels.len(), 1);
        assert_eq!(event_labels[0].0, "beach");
    }

    #[test]
    fn test_rename_label() {
        let conn = new_in_memory_db();
        let c = AiClassification {
            id: None,
            photo_id: 1,
            category: "scene".into(),
            label: "mountain".into(),
            confidence: 0.9,
        };
        insert_classification(&conn, &c).unwrap();
        rename_label(&conn, "mountain", "mountain_peak").unwrap();
        let results = get_classifications_for_photo(&conn, 1).unwrap();
        assert_eq!(results[0].label, "mountain_peak");
    }

    #[test]
    fn test_get_label_preview_photo_id() {
        let conn = new_in_memory_db();
        let c = AiClassification {
            id: None,
            photo_id: 42,
            category: "scene".into(),
            label: "beach".into(),
            confidence: 0.9,
        };
        insert_classification(&conn, &c).unwrap();
        let photo_id = get_label_preview_photo_id(&conn, "beach").unwrap();
        assert_eq!(photo_id, Some(42));
        let none_result = get_label_preview_photo_id(&conn, "nonexistent").unwrap();
        assert_eq!(none_result, None);
    }

    // ----- Hierarchy tests -----

    #[test]
    fn test_get_label_parents_contains_nature_labels() {
        let parents = get_label_parents();
        assert_eq!(parents.get("mountain"), Some(&"自然".to_string()));
        assert_eq!(parents.get("ocean"), Some(&"自然".to_string()));
        assert_eq!(parents.get("forest"), Some(&"自然".to_string()));
        assert_eq!(parents.get("beach"), Some(&"自然".to_string()));
        assert_eq!(parents.get("desert"), Some(&"自然".to_string()));
    }

    #[test]
    fn test_get_label_parents_contains_architecture_labels() {
        let parents = get_label_parents();
        assert_eq!(parents.get("building"), Some(&"建筑".to_string()));
        assert_eq!(parents.get("temple"), Some(&"建筑".to_string()));
        assert_eq!(parents.get("bridge"), Some(&"建筑".to_string()));
        assert_eq!(parents.get("skyscraper"), Some(&"建筑".to_string()));
    }

    #[test]
    fn test_get_label_parents_contains_transportation_labels() {
        let parents = get_label_parents();
        assert_eq!(parents.get("highway"), Some(&"交通".to_string()));
        assert_eq!(parents.get("airport"), Some(&"交通".to_string()));
        assert_eq!(parents.get("railway"), Some(&"交通".to_string()));
    }

    #[test]
    fn test_get_label_parents_contains_sports_labels() {
        let parents = get_label_parents();
        assert_eq!(parents.get("swimming_pool"), Some(&"运动".to_string()));
        assert_eq!(parents.get("tennis_court"), Some(&"运动".to_string()));
    }

    #[test]
    fn test_get_label_parents_contains_animal_labels() {
        let parents = get_label_parents();
        assert_eq!(parents.get("zoo"), Some(&"动物".to_string()));
        assert_eq!(parents.get("farm"), Some(&"动物".to_string()));
    }

    #[test]
    fn test_get_label_parents_contains_people_labels() {
        let parents = get_label_parents();
        assert_eq!(parents.get("person"), Some(&"人物".to_string()));
        assert_eq!(parents.get("crowd"), Some(&"人物".to_string()));
    }

    #[test]
    fn test_get_label_parents_contains_life_labels() {
        let parents = get_label_parents();
        assert_eq!(parents.get("market"), Some(&"生活".to_string()));
        assert_eq!(parents.get("street"), Some(&"生活".to_string()));
        assert_eq!(parents.get("park"), Some(&"生活".to_string()));
    }

    #[test]
    fn test_get_label_parents_size() {
        let parents = get_label_parents();
        // Should have a substantial number of mappings
        assert!(
            parents.len() > 50,
            "Expected more than 50 label mappings, got {}",
            parents.len()
        );
    }

    #[test]
    fn test_build_label_hierarchy_flat_nodes_no_parents() {
        let nodes = vec![
            LabelNode {
                id: 1,
                label: "mountain".into(),
                parent_id: None,
                label_type: "ai_scene".into(),
                count: 10,
                preview_thumbnail: None,
                children: vec![],
            },
            LabelNode {
                id: 2,
                label: "beach".into(),
                parent_id: None,
                label_type: "ai_scene".into(),
                count: 5,
                preview_thumbnail: None,
                children: vec![],
            },
        ];
        let result = build_label_hierarchy(nodes);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].label, "mountain");
        assert_eq!(result[0].count, 10);
        assert_eq!(result[1].label, "beach");
        assert_eq!(result[1].count, 5);
    }

    #[test]
    fn test_build_label_hierarchy_with_parent_categories() {
        // Parent node "自然" (id=100) with children "mountain" and "beach"
        let nodes = vec![
            LabelNode {
                id: 100,
                label: "自然".into(),
                parent_id: None,
                label_type: "ai_scene".into(),
                count: 0,
                preview_thumbnail: None,
                children: vec![],
            },
            LabelNode {
                id: 1,
                label: "mountain".into(),
                parent_id: Some(100),
                label_type: "ai_scene".into(),
                count: 10,
                preview_thumbnail: None,
                children: vec![],
            },
            LabelNode {
                id: 2,
                label: "beach".into(),
                parent_id: Some(100),
                label_type: "ai_scene".into(),
                count: 5,
                preview_thumbnail: None,
                children: vec![],
            },
        ];
        let result = build_label_hierarchy(nodes);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].label, "自然");
        // Parent count should be sum of children
        assert_eq!(result[0].count, 15);
        assert_eq!(result[0].children.len(), 2);
    }

    #[test]
    fn test_build_label_hierarchy_multi_level() {
        // 自然 -> landscape -> mountain
        let nodes = vec![
            LabelNode {
                id: 100,
                label: "自然".into(),
                parent_id: None,
                label_type: "ai_scene".into(),
                count: 0,
                preview_thumbnail: None,
                children: vec![],
            },
            LabelNode {
                id: 200,
                label: "landscape".into(),
                parent_id: Some(100),
                label_type: "ai_scene".into(),
                count: 0,
                preview_thumbnail: None,
                children: vec![],
            },
            LabelNode {
                id: 1,
                label: "mountain".into(),
                parent_id: Some(200),
                label_type: "ai_scene".into(),
                count: 10,
                preview_thumbnail: None,
                children: vec![],
            },
        ];
        let result = build_label_hierarchy(nodes);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].label, "自然");
        assert_eq!(result[0].count, 10);
        assert_eq!(result[0].children.len(), 1);
        assert_eq!(result[0].children[0].label, "landscape");
        assert_eq!(result[0].children[0].count, 10);
        assert_eq!(result[0].children[0].children.len(), 1);
        assert_eq!(result[0].children[0].children[0].label, "mountain");
        assert_eq!(result[0].children[0].children[0].count, 10);
    }

    #[test]
    fn test_build_label_hierarchy_multiple_parents() {
        let nodes = vec![
            LabelNode {
                id: 100,
                label: "自然".into(),
                parent_id: None,
                label_type: "ai_scene".into(),
                count: 0,
                preview_thumbnail: None,
                children: vec![],
            },
            LabelNode {
                id: 101,
                label: "建筑".into(),
                parent_id: None,
                label_type: "ai_scene".into(),
                count: 0,
                preview_thumbnail: None,
                children: vec![],
            },
            LabelNode {
                id: 1,
                label: "mountain".into(),
                parent_id: Some(100),
                label_type: "ai_scene".into(),
                count: 10,
                preview_thumbnail: None,
                children: vec![],
            },
            LabelNode {
                id: 2,
                label: "building".into(),
                parent_id: Some(101),
                label_type: "ai_scene".into(),
                count: 7,
                preview_thumbnail: None,
                children: vec![],
            },
        ];
        let result = build_label_hierarchy(nodes);
        assert_eq!(result.len(), 2);
        // Sort by label for deterministic assertion
        let mut sorted: Vec<_> = result.iter().map(|n| (&n.label, n.count)).collect();
        sorted.sort_by_key(|(l, _)| *l);
        assert_eq!(sorted[0].0.as_str(), "建筑");
        assert_eq!(sorted[0].1, 7);
        assert_eq!(sorted[1].0.as_str(), "自然");
        assert_eq!(sorted[1].1, 10);
    }

    #[test]
    fn test_build_label_hierarchy_empty_input() {
        let result = build_label_hierarchy(vec![]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_get_label_hierarchy_db_integration() {
        let conn = new_in_memory_db();

        // Insert photos
        conn.execute("INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (1, '/photos/a.jpg', 'a.jpg', 1000, 0, 0)", []).unwrap();
        conn.execute("INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (2, '/photos/b.jpg', 'b.jpg', 1000, 0, 0)", []).unwrap();
        conn.execute("INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (3, '/photos/c.jpg', 'c.jpg', 1000, 0, 0)", []).unwrap();

        // Insert classifications: mountain and beach should both map to 自然
        let c1 = AiClassification {
            id: None,
            photo_id: 1,
            category: "scene".into(),
            label: "mountain".into(),
            confidence: 0.9,
        };
        let c2 = AiClassification {
            id: None,
            photo_id: 2,
            category: "scene".into(),
            label: "beach".into(),
            confidence: 0.8,
        };
        let c3 = AiClassification {
            id: None,
            photo_id: 3,
            category: "scene".into(),
            label: "mountain".into(),
            confidence: 0.85,
        };
        insert_classification(&conn, &c1).unwrap();
        insert_classification(&conn, &c2).unwrap();
        insert_classification(&conn, &c3).unwrap();

        let hierarchy = get_label_hierarchy(&conn).unwrap();
        // Should have one parent category "自然" with mountain and beach as children
        assert_eq!(
            hierarchy.len(),
            1,
            "Expected 1 root category, got {}",
            hierarchy.len()
        );
        assert_eq!(hierarchy[0].label, "自然");
        assert_eq!(hierarchy[0].count, 3); // 2 mountain + 1 beach
        assert_eq!(hierarchy[0].children.len(), 2);

        // Children should be sorted by count: mountain (2), beach (1)
        assert_eq!(hierarchy[0].children[0].label, "mountain");
        assert_eq!(hierarchy[0].children[0].count, 2);
        assert_eq!(hierarchy[0].children[1].label, "beach");
        assert_eq!(hierarchy[0].children[1].count, 1);
    }

    #[test]
    fn test_get_labels_with_previews_highest_confidence() {
        let conn = new_in_memory_db();

        conn.execute("INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (1, '/photos/low.jpg', 'low.jpg', 1000, 0, 0)", []).unwrap();
        conn.execute("INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (2, '/photos/high.jpg', 'high.jpg', 1000, 0, 0)", []).unwrap();

        // Two classifications for same label, different confidence
        let c1 = AiClassification {
            id: None,
            photo_id: 1,
            category: "scene".into(),
            label: "mountain".into(),
            confidence: 0.3,
        };
        let c2 = AiClassification {
            id: None,
            photo_id: 2,
            category: "scene".into(),
            label: "mountain".into(),
            confidence: 0.9,
        };
        insert_classification(&conn, &c1).unwrap();
        insert_classification(&conn, &c2).unwrap();

        let previews = get_labels_with_previews(&conn).unwrap();
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].0, "mountain");
        assert_eq!(previews[0].1, 2);
        // Should return the high confidence photo's path
        assert!(
            previews[0].2.as_deref() == Some("/photos/high.jpg"),
            "Expected high confidence photo path, got {:?}",
            previews[0].2
        );
    }
}

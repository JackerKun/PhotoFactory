use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Datelike, Days, NaiveDate, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    tags::places365_cn::translate_label,
};

const MAX_EVENT_GAP: i64 = 5 * 3600;
const MAX_EVENT_SPAN: i64 = 16 * 3600;
const MAX_EVENT_DISTANCE_KM: f64 = 35.0;
const MAX_MEMORY_PHOTOS: usize = 24;
const MIN_MEMORY_PHOTOS: usize = 4;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Event,
    Anniversary,
}

#[derive(Deserialize, Serialize)]
pub struct PhotoMemory {
    id: i64,
    kind: MemoryKind,
    title: String,
    start_at: i64,
    end_at: i64,
    source_count: usize,
    cover_photo_id: i64,
    photo_ids: Vec<i64>,
    location: Option<String>,
    gps_count: usize,
    people: Vec<String>,
    scene: Option<String>,
    indexed_count: usize,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    tags: Vec<String>,
}

struct Candidate {
    id: i64,
    taken_at: i64,
    gps: Option<(f64, f64)>,
    rating: i64,
    favorite: bool,
    sharpness: Option<f64>,
    fingerprint: Option<u64>,
    duplicate_group: Option<String>,
    location: Option<String>,
    scenes: BTreeSet<String>,
    people: Vec<String>,
}

impl Candidate {
    fn score(&self) -> f64 {
        let sharpness = self.sharpness.map_or(0.0, |value| value.clamp(0.0, 30.0));
        let favorite = if self.favorite { 30.0 } else { 0.0 };
        let people = if self.people.is_empty() { 0.0 } else { 4.0 };
        let scene = if self.scenes.is_empty() { 0.0 } else { 2.0 };
        sharpness + self.rating as f64 * 10.0 + favorite + people + scene
    }
}

pub fn get_memories(conn: &Connection, today: NaiveDate) -> AppResult<Vec<PhotoMemory>> {
    let mut generated = generate_memories(conn, today)?;
    let mut stmt = conn.prepare(
        "SELECT memory_json, favorite, tags_json FROM saved_photo_memories ORDER BY id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, bool>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (json, favorite, tags) = row?;
        let mut memory: PhotoMemory = serde_json::from_str(&json)?;
        retain_visible_photos(conn, &mut memory)?;
        if memory.photo_ids.is_empty() {
            continue;
        }
        memory.favorite = favorite;
        memory.tags = serde_json::from_str(&tags)?;
        generated.retain(|candidate| {
            candidate.id != memory.id
                && candidate
                    .photo_ids
                    .iter()
                    .filter(|id| memory.photo_ids.contains(id))
                    .count()
                    * 2
                    < candidate.photo_ids.len().min(memory.photo_ids.len()).max(4)
        });
        result.push(memory);
    }
    result.extend(generated);
    Ok(result)
}

fn retain_visible_photos(conn: &Connection, memory: &mut PhotoMemory) -> AppResult<()> {
    let ids = serde_json::to_string(&memory.photo_ids)?;
    let mut stmt = conn.prepare_cached(
        "SELECT p.id FROM json_each(?1) j JOIN photos p ON p.id = j.value
         LEFT JOIN photo_intelligence i ON i.photo_id = p.id
         WHERE p.deleted = 0 AND COALESCE(i.is_private, 0) = 0 AND COALESCE(i.is_sensitive, 0) = 0
           AND NOT EXISTS (SELECT 1 FROM photo_trash t WHERE t.photo_id = p.id)
         ORDER BY j.key",
    )?;
    let visible = stmt
        .query_map([ids], |row| row.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    if visible.len() != memory.photo_ids.len() {
        memory.title = "拍摄回顾".into();
        memory.location = None;
        memory.scene = None;
        memory.people.clear();
        memory.gps_count = 0;
        memory.indexed_count = 0;
        memory.source_count = visible.len();
        if let Some(first) = visible.first() {
            if !visible.contains(&memory.cover_photo_id) {
                memory.cover_photo_id = *first;
            }
        }
        memory.photo_ids = visible;
    }
    Ok(())
}

pub fn save_memory_preferences(
    conn: &Connection,
    today: NaiveDate,
    id: i64,
    favorite: bool,
    tags: Vec<String>,
) -> AppResult<()> {
    let mut seen = HashSet::new();
    let tags: Vec<_> = tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty() && seen.insert(tag.to_lowercase()))
        .collect();
    if tags.len() > 20 || tags.iter().any(|tag| tag.chars().count() > 32) {
        return Err(AppError::Project(
            "每条回忆最多保存 20 个标签，每个标签最多 32 个字符。".into(),
        ));
    }
    if !favorite && tags.is_empty() {
        conn.execute("DELETE FROM saved_photo_memories WHERE id = ?1", [id])?;
        return Ok(());
    }
    let tags_json = serde_json::to_string(&tags)?;
    let existing = conn.execute(
        "UPDATE saved_photo_memories SET favorite = ?2, tags_json = ?3 WHERE id = ?1",
        params![id, favorite, tags_json],
    )?;
    if existing == 0 {
        let memory = generate_memories(conn, today)?
            .into_iter()
            .find(|memory| memory.id == id)
            .ok_or_else(|| AppError::NotFound("这条回忆已变化，请刷新后再试。".into()))?;
        conn.execute(
            "INSERT INTO saved_photo_memories(id, memory_json, favorite, tags_json) VALUES (?1, ?2, ?3, ?4)",
            params![id, serde_json::to_string(&memory)?, favorite, tags_json],
        )?;
    }
    Ok(())
}

fn generate_memories(conn: &Connection, today: NaiveDate) -> AppResult<Vec<PhotoMemory>> {
    // The scanner stores EXIF wall-clock dates as UTC. Use the same convention
    // for calendar matching and use indexed timestamp ranges for each year.
    let midnight = |date: NaiveDate| date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
    let mut stmt = conn.prepare(
        "SELECT p.id, p.taken_at, p.latitude, p.longitude, p.rating, p.is_favorite,
                i.sharpness, i.perceptual_hash, i.duplicate_group,
                (SELECT a.label FROM ai_classifications a
                 WHERE a.photo_id = p.id AND a.tag_type = 'geo_location'
                 ORDER BY a.confidence DESC, a.id LIMIT 1),
                (SELECT json_group_array(json_array(a.label, a.tag_type))
                 FROM ai_classifications a
                 WHERE a.photo_id = p.id AND a.confidence >= 0.25
                   AND (a.tag_type = 'ai_scene' OR
                        (a.tag_type = 'ai_semantic' AND a.category IN ('自然', '建筑', '活动')))
                   AND a.label NOT IN ('s_sky', 'sky', '天空', '旅行')),
                (SELECT json_group_array(DISTINCT trim(c.name))
                 FROM face_detections f JOIN face_clusters c ON c.id = f.person_id
                 WHERE f.photo_id = p.id AND COALESCE(f.review_status, 'active') = 'active'
                   AND trim(c.name) <> '')
         FROM photos p LEFT JOIN photo_intelligence i ON i.photo_id = p.id
         WHERE p.deleted = 0 AND p.taken_at >= ?1 AND p.taken_at < ?2
           AND COALESCE(i.is_private, 0) = 0 AND COALESCE(i.is_sensitive, 0) = 0
           AND NOT EXISTS (SELECT 1 FROM photo_trash t WHERE t.photo_id = p.id)
         ORDER BY p.taken_at DESC, p.id DESC LIMIT ?3",
    )?;
    let mut load = |start: i64, end: i64, limit: i64| -> AppResult<Vec<Candidate>> {
        let rows = stmt.query_map(params![start, end, limit], |row| {
            let lat: Option<f64> = row.get(2)?;
            let lng: Option<f64> = row.get(3)?;
            let fingerprint = row
                .get::<_, Option<String>>(7)?
                .and_then(|hash| u64::from_str_radix(&hash, 16).ok());
            let labels: Vec<(String, String)> =
                serde_json::from_str(&row.get::<_, String>(10)?).unwrap_or_default();
            let scenes = labels
                .into_iter()
                .filter_map(|(label, source)| {
                    if source == "ai_semantic" {
                        return Some(label);
                    }
                    let translation = translate_label(&label);
                    (translation != label).then(|| translation.to_string())
                })
                .collect();
            Ok(Candidate {
                id: row.get(0)?,
                taken_at: row.get(1)?,
                gps: lat.zip(lng).filter(|(lat, lng)| {
                    (-90.0..=90.0).contains(lat)
                        && (-180.0..=180.0).contains(lng)
                        && (*lat != 0.0 || *lng != 0.0)
                }),
                rating: row.get(4)?,
                favorite: row.get::<_, Option<bool>>(5)?.unwrap_or(false),
                sharpness: row
                    .get::<_, Option<f64>>(6)?
                    .filter(|_| fingerprint.is_some()),
                fingerprint,
                duplicate_group: row.get(8)?,
                location: row.get(9)?,
                scenes,
                people: serde_json::from_str(&row.get::<_, String>(11)?).unwrap_or_default(),
            })
        })?;
        let mut photos = rows.collect::<Result<Vec<_>, _>>()?;
        photos.reverse();
        Ok(photos)
    };

    let mut memories = Vec::new();
    let mut anniversary_ids = HashSet::new();
    // Test each year's own calendar window, including leap years and year boundaries.
    for years_ago in 1..=12 {
        let year = today.year() - years_ago;
        let Some(date) = today
            .with_year(year)
            .or_else(|| NaiveDate::from_ymd_opt(year, 2, 28))
        else {
            continue;
        };
        let photos = load(
            midnight(date - Days::new(3)),
            midnight(date + Days::new(4)),
            1500,
        )?;
        let best = events(&photos)
            .into_iter()
            .filter(|event| {
                let Some(first) = DateTime::from_timestamp(event[0].taken_at, 0) else {
                    return false;
                };
                first.year() < today.year()
            })
            .filter_map(|event| build_memory(event, MemoryKind::Anniversary))
            .max_by_key(|memory| (memory.photo_ids.len(), memory.source_count, memory.start_at));
        if let Some(memory) = best {
            anniversary_ids.extend(memory.photo_ids.iter().copied());
            memories.push(memory);
            if memories.len() == 4 {
                break;
            }
        }
    }

    let photos = load(1, midnight(today + Days::new(1)), 6000)?;
    memories.extend(
        events(&photos)
            .into_iter()
            .rev()
            .filter(|event| {
                !event
                    .iter()
                    .any(|photo| anniversary_ids.contains(&photo.id))
            })
            .filter_map(|event| build_memory(event, MemoryKind::Event))
            .take(12),
    );
    Ok(memories)
}

fn events(photos: &[Candidate]) -> Vec<&[Candidate]> {
    if photos.is_empty() {
        return Vec::new();
    }
    let mut groups = Vec::new();
    let mut start = 0;
    let mut last_gps = photos[0].gps;
    for index in 1..photos.len() {
        let photo = &photos[index];
        let moved = last_gps
            .zip(photo.gps)
            .is_some_and(|(a, b)| distance_km(a, b) > MAX_EVENT_DISTANCE_KM);
        if moved
            || photo.taken_at - photos[index - 1].taken_at > MAX_EVENT_GAP
            || photo.taken_at - photos[start].taken_at > MAX_EVENT_SPAN
        {
            groups.push(&photos[start..index]);
            start = index;
            last_gps = None;
        }
        last_gps = photo.gps.or(last_gps);
    }
    groups.push(&photos[start..]);
    groups
}

fn distance_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let lat = (b.0 - a.0).to_radians() / 2.0;
    let lon = (b.1 - a.1).to_radians() / 2.0;
    let haversine =
        lat.sin().powi(2) + a.0.to_radians().cos() * b.0.to_radians().cos() * lon.sin().powi(2);
    12_742.0 * haversine.clamp(0.0, 1.0).sqrt().asin()
}

fn frequent_labels<'a>(labels: impl Iterator<Item = &'a str>, minimum: usize) -> Vec<String> {
    let mut counts = HashMap::new();
    for label in labels.map(str::trim).filter(|label| !label.is_empty()) {
        *counts.entry(label).or_insert(0) += 1;
    }
    let mut counts: Vec<_> = counts
        .into_iter()
        .filter(|(_, count)| *count >= minimum)
        .collect();
    counts.sort_by(|(a, a_count), (b, b_count)| b_count.cmp(a_count).then_with(|| a.cmp(b)));
    counts
        .into_iter()
        .map(|(label, _)| label.to_string())
        .collect()
}

fn build_memory(photos: &[Candidate], kind: MemoryKind) -> Option<PhotoMemory> {
    if photos.len() < MIN_MEMORY_PHOTOS {
        return None;
    }
    let start_at = photos.first()?.taken_at;
    let end_at = photos.last()?.taken_at;
    let date: DateTime<Utc> = DateTime::from_timestamp(start_at, 0)?;
    let mut ranked: Vec<_> = photos.iter().collect();
    ranked.sort_by(|a, b| {
        b.score()
            .total_cmp(&a.score())
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut selected: Vec<&Candidate> = Vec::new();
    let mut duplicate_groups = HashSet::new();
    let mut occupied_moments = BTreeSet::new();
    // Keep a strong cover and represent different parts of the event before
    // filling spare places with other highly ranked photos.
    let moment_length = ((end_at - start_at) / 12).max(1);
    for spread in [true, false] {
        for &photo in &ranked {
            let moment = (photo.taken_at - start_at) / moment_length;
            if selected.len() == MAX_MEMORY_PHOTOS {
                break;
            }
            if (spread && occupied_moments.contains(&moment))
                || photo
                    .duplicate_group
                    .as_ref()
                    .is_some_and(|group| duplicate_groups.contains(group))
                || selected.iter().any(|other| {
                    photo.id == other.id
                        || photo
                            .fingerprint
                            .zip(other.fingerprint)
                            .is_some_and(|(a, b)| {
                                (a ^ b).count_ones() <= 5
                                    && photo.taken_at.abs_diff(other.taken_at) <= 120
                            })
                })
            {
                continue;
            }
            selected.push(photo);
            occupied_moments.insert(moment);
            if let Some(group) = &photo.duplicate_group {
                duplicate_groups.insert(group);
            }
        }
    }
    if selected.len() < MIN_MEMORY_PHOTOS {
        return None;
    }
    let cover_photo_id = selected.first()?.id;
    selected.sort_by_key(|photo| (photo.taken_at, photo.id));

    let location = frequent_labels(
        selected
            .iter()
            .filter_map(|photo| photo.location.as_deref()),
        selected.len().div_ceil(2),
    )
    .into_iter()
    .next();
    let scene = frequent_labels(
        selected
            .iter()
            .flat_map(|photo| photo.scenes.iter().map(String::as_str)),
        selected.len().div_ceil(3).max(2),
    )
    .into_iter()
    .next();
    let people: Vec<_> = frequent_labels(
        selected
            .iter()
            .flat_map(|photo| photo.people.iter().map(String::as_str)),
        2,
    )
    .into_iter()
    .take(3)
    .collect();

    let title = match (&kind, &location, &scene, people.first()) {
        (MemoryKind::Anniversary, Some(location), _, _) => format!("重温{location}"),
        (MemoryKind::Anniversary, None, _, _) => format!("{}年的此时", date.year()),
        (_, Some(location), _, _) => format!("{location}的影像"),
        (_, _, Some(scene), _) => format!("{scene}一刻"),
        (_, _, _, Some(person)) => format!("与{person}的时光"),
        _ => date.format("%-m月%-d日的影像").to_string(),
    };
    Some(PhotoMemory {
        id: photos[0].id,
        kind,
        title,
        start_at,
        end_at,
        source_count: photos.len(),
        cover_photo_id,
        photo_ids: selected.iter().map(|photo| photo.id).collect(),
        location,
        gps_count: selected.iter().filter(|photo| photo.gps.is_some()).count(),
        people,
        scene,
        indexed_count: selected
            .iter()
            .filter(|photo| photo.fingerprint.is_some())
            .count(),
        favorite: false,
        tags: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::CREATE_TABLES;

    #[test]
    fn curates_events_and_anniversaries_from_visible_photos() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        conn.execute_batch("ALTER TABLE ai_classifications ADD COLUMN tag_type TEXT;")
            .unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let recent = today.and_hms_opt(9, 0, 0).unwrap().and_utc().timestamp();
        // Dec 31 falls inside the previous anniversary's window across New Year.
        let past = NaiveDate::from_ymd_opt(2024, 12, 31)
            .unwrap()
            .and_hms_opt(9, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp();
        for id in 1..=19 {
            let taken = if id >= 16 { past } else { recent } + id * 60;
            let lng = if (12..=15).contains(&id) {
                119.0
            } else {
                116.0
            };
            conn.execute(
                "INSERT INTO photos(id,path,filename,file_size,file_mtime,taken_at,latitude,longitude,rating,imported_at)
                 VALUES(?1,?2,'photo.jpg',10,?3,?3,40,?4,?5,?3)",
                params![id, format!("/{id}.jpg"), taken, lng, if id == 5 { 5 } else { 0 }],
            ).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO photo_intelligence(photo_id,duplicate_group) VALUES(5,'same'),(6,'same');
             INSERT INTO photo_intelligence(photo_id,is_private) VALUES(7,1);
             INSERT INTO photo_intelligence(photo_id,is_sensitive) VALUES(8,1);
             INSERT INTO photo_trash(photo_id,trashed_at) VALUES(9,1);
             UPDATE photos SET deleted=1 WHERE id=10;
             UPDATE photos SET taken_at=NULL WHERE id=11;
             INSERT INTO face_clusters(id,name,created_at) VALUES(1,'小张',1),(2,'被忽略的人',1);
             INSERT INTO face_detections(photo_id,person_id,created_at,review_status)
                VALUES(1,1,1,'active'),(2,1,1,'active'),(3,2,1,'ignored'),(4,2,1,'ignored');",
        )
        .unwrap();
        for id in 1..=5 {
            conn.execute(
                "INSERT INTO ai_classifications(photo_id,category,label,confidence,tag_type)
                 VALUES(?1,'scene','b_beach',0.8,'ai_scene'),(?1,'scene','s_sky',0.99,'ai_scene'),
                       (?1,'geo','示例景区',1,'geo_location')",
                [id],
            )
            .unwrap();
        }

        conn.execute_batch(
            "INSERT INTO ai_classifications(photo_id,category,label,confidence,tag_type)
             VALUES(12,'自然','山景',0.4,'ai_semantic'),(13,'自然','山景',0.5,'ai_semantic');",
        )
        .unwrap();

        let memories = get_memories(&conn, today).unwrap();
        assert_eq!(memories.len(), 3);
        assert!(matches!(memories[0].kind, MemoryKind::Anniversary));
        assert_eq!(memories[0].photo_ids, [16, 17, 18, 19]);
        assert_eq!(memories[1].photo_ids, [12, 13, 14, 15]);
        assert_eq!(memories[1].scene.as_deref(), Some("山景"));
        let memory = &memories[2];
        assert_eq!(memory.photo_ids, [1, 2, 3, 4, 5]);
        assert_eq!(memory.source_count, 6);
        assert_eq!(memory.cover_photo_id, 5);
        assert_eq!(memory.location.as_deref(), Some("示例景区"));
        assert_eq!(memory.people, ["小张"]);
        assert_eq!(memory.scene.as_deref(), Some(translate_label("b_beach")));

        let anniversary_id = memories[0].id;
        save_memory_preferences(&conn, today, anniversary_id, false, vec!["往年".into()]).unwrap();
        save_memory_preferences(
            &conn,
            today,
            memory.id,
            true,
            vec![" 山野 ".into(), "山野".into()],
        )
        .unwrap();
        // A saved selection remains accessible outside its anniversary window
        // and drops photos that subsequently become private.
        conn.execute(
            "UPDATE photo_intelligence SET is_private=1 WHERE photo_id=5",
            [],
        )
        .unwrap();
        let later = today + Days::new(14);
        let saved = get_memories(&conn, later).unwrap();
        assert!(saved.iter().any(|item| {
            item.id == anniversary_id && matches!(item.kind, MemoryKind::Anniversary)
        }));
        let entry = saved.iter().find(|item| item.id == memory.id).unwrap();
        assert!(entry.favorite);
        assert_eq!(entry.tags, ["山野"]);
        assert_eq!(entry.photo_ids, [1, 2, 3, 4]);
        assert_eq!(entry.cover_photo_id, 1);
        assert_eq!(entry.scene, None);
        save_memory_preferences(&conn, later, memory.id, false, vec![]).unwrap();
        save_memory_preferences(&conn, later, anniversary_id, false, vec![]).unwrap();
        let refreshed = get_memories(&conn, later).unwrap();
        assert!(refreshed
            .iter()
            .all(|item| !item.favorite && item.tags.is_empty()));
    }
}

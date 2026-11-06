use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualTag {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub photo_count: i64,
}

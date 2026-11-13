// src-tauri/src/models/ai.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiClassification {
    pub id: Option<i64>,
    pub photo_id: i64,
    pub category: String,
    pub label: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceDetection {
    pub id: Option<i64>,
    pub photo_id: i64,
    pub bbox_x: i32,
    pub bbox_y: i32,
    pub bbox_w: i32,
    pub bbox_h: i32,
    pub embedding_path: Option<String>,
    pub person_id: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceCluster {
    pub id: Option<i64>,
    pub name: Option<String>,
    pub face_count: i32,
    pub photo_count: i32,
    pub confidence: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceClusterPage {
    pub items: Vec<FaceCluster>,
    pub total: i64,
    pub named_count: i64,
    pub unnamed_count: i64,
    pub review_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomAttribute {
    pub id: Option<i64>,
    pub photo_id: i64,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyRequest {
    pub paths: Vec<String>,
    pub model: String,
    #[serde(default)]
    pub previews: std::collections::HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTag {
    pub label: String,
    pub confidence: f64,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub tag_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyResult {
    pub path: String,
    pub tags: Vec<AiTag>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyResponse {
    pub results: Vec<ClassifyResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectFacesRequest {
    pub paths: Vec<String>,
    pub cache_dir: String,
    pub previews: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedFace {
    pub bbox: [i32; 4],
    pub embedding: Vec<f32>,
    pub embedding_path: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub quality_score: f64,
    #[serde(default)]
    pub landmarks: Vec<f64>,
    #[serde(default)]
    pub pose_yaw: f64,
    #[serde(default)]
    pub pose_pitch: f64,
    #[serde(default)]
    pub pose_roll: f64,
    #[serde(default)]
    pub alignment_success: bool,
}

#[derive(Debug, Clone, Default)]
pub struct FaceDetectionMetadata {
    pub confidence: f64,
    pub quality_score: f64,
    pub landmarks_json: Option<String>,
    pub pose_yaw: f64,
    pub pose_pitch: f64,
    pub pose_roll: f64,
    pub alignment_success: bool,
    pub review_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceResult {
    pub path: String,
    pub faces: Vec<DetectedFace>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectFacesResponse {
    pub results: Vec<FaceResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    #[serde(default)]
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterFaceRequest {
    pub embeddings_dir: String,
    pub existing_clusters: std::collections::HashMap<String, Vec<Vec<f32>>>,
    pub threshold: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterAssignment {
    pub embedding_file: String,
    pub cluster_id: i64,
    pub is_new_cluster: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterFaceResponse {
    pub assignments: Vec<ClusterAssignment>,
}

/// Request for v2 clustering with constraints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterFaceV2Request {
    pub embeddings_dir: String,
    pub existing_clusters: Option<std::collections::HashMap<String, i64>>,
    pub threshold: Option<f64>,
    pub must_links: Option<Vec<(i64, i64)>>,
    pub cannot_links: Option<Vec<(i64, i64)>>,
    pub candidate_files: Option<Vec<String>>,
    pub memberships: std::collections::HashMap<String, i64>,
    pub qualities: std::collections::HashMap<String, f64>,
}

/// Response from v2 clustering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterFaceV2Response {
    pub clusters: std::collections::HashMap<String, i64>,
    #[serde(default)]
    pub review_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomaticFaceMergeRequest {
    pub embeddings_dir: String,
    pub unnamed_clusters: std::collections::HashMap<String, i64>,
    pub threshold: f64,
    pub cannot_links: Vec<(i64, i64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomaticFaceMergeCandidate {
    pub cluster_ids: Vec<i64>,
    pub similarity: f64,
    pub face_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomaticFaceMergeResponse {
    pub candidates: Vec<AutomaticFaceMergeCandidate>,
}

use reqwest::Client;

use crate::error::{AppError, AppResult};
use crate::models::{
    AutomaticFaceMergeProgress, AutomaticFaceMergeRequest, AutomaticFaceMergeResponse,
    ClassifyRequest, ClassifyResponse, ClusterFaceRequest, ClusterFaceResponse,
    ClusterFaceV2Request, ClusterFaceV2Response, DetectFacesRequest, DetectFacesResponse,
    HealthResponse,
};

async fn worker_response_text(response: reqwest::Response) -> AppResult<String> {
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        let detail: String = text.chars().take(2000).collect();
        return Err(AppError::AiWorker(format!("HTTP {status}: {detail}")));
    }
    Ok(text)
}

#[derive(Clone)]
pub struct AiWorkerClient {
    client: Client,
    long_client: Client,
    base_url: String,
    pub port: u16,
    pub pid: u32,
    instance_id: String,
}

impl AiWorkerClient {
    pub fn same_instance(&self, other: &Self) -> bool {
        self.instance_id == other.instance_id
    }

    pub fn new(port: u16, pid: u32, instance_id: String) -> Self {
        Self {
            client: Client::builder().no_proxy().build().unwrap(),
            long_client: Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(300))
                .build()
                .unwrap(),
            base_url: format!("http://127.0.0.1:{}", port),
            port,
            pid,
            instance_id,
        }
    }

    pub async fn health_check(&self) -> AppResult<bool> {
        match self
            .client
            .get(format!("{}/health", self.base_url))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let health: HealthResponse = resp.json().await.map_err(|e| AppError::Http(e))?;
                Ok(health.status == "ok"
                    && health.instance_id.as_deref() == Some(&self.instance_id))
            }
            Ok(_) | Err(_) => Ok(false),
        }
    }

    pub async fn runtime_info(&self) -> AppResult<serde_json::Value> {
        Ok(self
            .client
            .get(format!("{}/runtime", self.base_url))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    pub async fn classify(&self, req: &ClassifyRequest) -> AppResult<ClassifyResponse> {
        let resp = self
            .long_client
            .post(format!("{}/classify", self.base_url))
            .json(req)
            .send()
            .await
            .map_err(|e| AppError::Http(e))?;
        let text = worker_response_text(resp).await?;
        let result: ClassifyResponse = serde_json::from_str(&text)?;
        Ok(result)
    }

    pub async fn detect_faces(
        &self,
        paths: Vec<String>,
        cache_dir: &str,
        previews: std::collections::HashMap<String, String>,
    ) -> AppResult<DetectFacesResponse> {
        let req = DetectFacesRequest {
            paths,
            cache_dir: cache_dir.to_string(),
            previews,
        };
        let resp = self
            .long_client
            .post(format!("{}/detect_faces", self.base_url))
            .json(&req)
            .send()
            .await
            .map_err(|e| AppError::Http(e))?;
        let status = resp.status();
        let text = worker_response_text(resp).await?;
        println!(
            "detect_faces response status: {}, body length: {}",
            status,
            text.len()
        );
        if text.len() < 2000 {
            println!("detect_faces body: {}", text);
        }
        let result: DetectFacesResponse = serde_json::from_str(&text).map_err(|e| {
            AppError::AiWorker(format!(
                "JSON parse error: {}\nResponse: {}",
                e,
                text.chars().take(500).collect::<String>()
            ))
        })?;
        Ok(result)
    }

    pub async fn cluster_faces(&self, req: ClusterFaceRequest) -> AppResult<ClusterFaceResponse> {
        let resp = self
            .client
            .post(format!("{}/cluster_faces", self.base_url))
            .json(&req)
            .send()
            .await
            .map_err(|e| AppError::Http(e))?;
        let result: ClusterFaceResponse = resp.json().await.map_err(|e| AppError::Http(e))?;
        Ok(result)
    }

    pub async fn cluster_faces_v2(
        &self,
        req: &ClusterFaceV2Request,
    ) -> AppResult<ClusterFaceV2Response> {
        let resp = self
            .long_client
            .post(format!("{}/cluster_faces_v2", self.base_url))
            .json(req)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| AppError::Http(e))?;
        println!(
            "cluster_faces_v2 response status: {}, body length: {}",
            status,
            text.len()
        );
        if !status.is_success() {
            let detail: String = text.chars().take(500).collect();
            return Err(AppError::AiWorker(format!("HTTP {}: {}", status, detail)));
        }
        let result: ClusterFaceV2Response = serde_json::from_str(&text).map_err(|e| {
            AppError::AiWorker(format!(
                "JSON parse error: {}\nResponse: {}",
                e,
                text.chars().take(500).collect::<String>()
            ))
        })?;
        Ok(result)
    }

    pub async fn automatic_face_merge_progress(
        &self,
        request_id: &str,
    ) -> AppResult<Option<AutomaticFaceMergeProgress>> {
        self.face_progress("plan_automatic_face_merges", request_id)
            .await
    }

    pub async fn face_progress(
        &self,
        endpoint: &str,
        request_id: &str,
    ) -> AppResult<Option<AutomaticFaceMergeProgress>> {
        let response = self
            .client
            .get(format!(
                "{}/{endpoint}/progress/{request_id}",
                self.base_url
            ))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await?
            .error_for_status()?;
        Ok(response.json().await?)
    }

    pub async fn plan_automatic_face_merges(
        &self,
        req: &AutomaticFaceMergeRequest,
    ) -> AppResult<AutomaticFaceMergeResponse> {
        let resp = self
            .long_client
            .post(format!("{}/plan_automatic_face_merges", self.base_url))
            .json(req)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    AppError::AiWorker("相似人物分析超过 5 分钟，AI 服务没有返回结果".into())
                } else {
                    AppError::AiWorker(format!("无法请求本地 AI 服务：{error}"))
                }
            })?;
        let status = resp.status();
        if !status.is_success() {
            let detail = resp.text().await.unwrap_or_default();
            return Err(AppError::AiWorker(format!("HTTP {}: {}", status, detail)));
        }
        resp.json().await.map_err(AppError::Http)
    }
}

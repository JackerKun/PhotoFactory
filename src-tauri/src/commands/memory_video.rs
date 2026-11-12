use std::{io::Write, path::PathBuf, sync::Mutex};

use tauri::{
    ipc::{InvokeBody, Request},
    State,
};

use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct MemoryVideoState(Mutex<Option<VideoExport>>);

struct VideoExport {
    id: String,
    destination: PathBuf,
    file: tempfile::NamedTempFile,
    bytes: usize,
}

#[tauri::command]
pub fn cmd_begin_memory_video(
    destination: String,
    state: State<'_, MemoryVideoState>,
) -> AppResult<String> {
    let destination = PathBuf::from(destination);
    let extension = destination.extension().and_then(|ext| ext.to_str());
    if !destination.is_absolute()
        || !extension
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4") || ext.eq_ignore_ascii_case("webm"))
    {
        return Err(AppError::InvalidPath(
            "请选择 MP4 或 WebM 视频文件。".into(),
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::InvalidPath("视频目录无效。".into()))?;
    let mut active = state.0.lock().unwrap();
    if active.is_some() {
        return Err(AppError::Project("已有一个回忆正在导出。".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let file = tempfile::Builder::new()
        .prefix(".photofactory-video-")
        .tempfile_in(parent)?;
    *active = Some(VideoExport {
        id: id.clone(),
        destination,
        file,
        bytes: 0,
    });
    Ok(id)
}

#[tauri::command]
pub fn cmd_append_memory_video(
    request: Request<'_>,
    state: State<'_, MemoryVideoState>,
) -> AppResult<()> {
    let id = request
        .headers()
        .get("x-photo-video-id")
        .and_then(|value| value.to_str().ok());
    let decoded;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(value)
            if value
                .as_array()
                .is_some_and(|items| items.len() <= 1024 * 1024) =>
        {
            decoded = serde_json::from_value::<Vec<u8>>(value.clone())?;
            &decoded
        }
        _ => return Err(AppError::Project("视频数据格式无效。".into())),
    };
    let mut active = state.0.lock().unwrap();
    let export = active
        .as_mut()
        .filter(|item| Some(item.id.as_str()) == id)
        .ok_or_else(|| AppError::NotFound("导出任务已结束。".into()))?;
    if bytes.len() > 1024 * 1024 || export.bytes + bytes.len() > 256 * 1024 * 1024 {
        return Err(AppError::Project("视频超出导出大小限制。".into()));
    }
    export.file.write_all(bytes)?;
    export.bytes += bytes.len();
    Ok(())
}

#[tauri::command]
pub async fn cmd_finish_memory_video(
    id: String,
    save: bool,
    state: State<'_, MemoryVideoState>,
) -> AppResult<()> {
    let export = {
        let mut active = state.0.lock().unwrap();
        if active.as_ref().is_none_or(|item| item.id != id) {
            return if save {
                Err(AppError::NotFound("视频导出任务已结束。".into()))
            } else {
                Ok(())
            };
        }
        active.take().unwrap()
    };
    if !save {
        return Ok(());
    }
    if export.bytes == 0 {
        return Err(AppError::Project("未录制到视频画面。".into()));
    }
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        export.file.as_file().sync_all()?;
        export
            .file
            .persist(export.destination)
            .map_err(|error| error.error)?;
        Ok(())
    })
    .await
    .map_err(|error| AppError::Internal(format!("视频保存中断：{error}")))?
}

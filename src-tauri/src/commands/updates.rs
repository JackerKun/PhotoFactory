use std::time::Duration;

use once_cell::sync::Lazy;
use reqwest::{redirect::Policy, Client, StatusCode, Url};
use semver::Version;
use serde::{Deserialize, Serialize};

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/JackerKun/PhotoFactory/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/JackerKun/PhotoFactory/releases";
const RATE_LIMITED: &str = "检查更新过于频繁，请稍后重试。";

static RELEASE_CLIENT: Lazy<Result<Client, reqwest::Error>> = Lazy::new(|| {
    Client::builder()
        .user_agent("PhotoFactory")
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .build()
});

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

#[derive(Debug, Serialize)]
pub struct ReleaseVersion {
    tag: String,
    version: String,
    is_newer: bool,
}

#[derive(Serialize)]
pub struct UpdateCheck {
    current_version: String,
    latest_release: Option<ReleaseVersion>,
}

impl GitHubRelease {
    fn compare(self, current: &Version) -> Result<Option<ReleaseVersion>, &'static str> {
        if self.draft || self.prerelease {
            return Ok(None);
        }

        compare_tag(&self.tag_name, current)
    }
}

fn compare_tag(tag: &str, current: &Version) -> Result<Option<ReleaseVersion>, &'static str> {
    let version = Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .map_err(|_| "GitHub 发布的版本号无法识别。")?;
    if !version.pre.is_empty() {
        return Ok(None);
    }

    Ok(Some(ReleaseVersion {
        tag: tag.to_owned(),
        version: version.to_string(),
        is_newer: version.cmp_precedence(current).is_gt(),
    }))
}

fn release_tag_from_redirect(destination: &Url) -> Result<Option<&str>, &'static str> {
    if destination.as_str() == RELEASES_PAGE {
        return Ok(None);
    }
    destination
        .as_str()
        .strip_prefix(&format!("{RELEASES_PAGE}/tag/"))
        .map(Some)
        .ok_or(RATE_LIMITED)
}

async fn check_release_page(
    client: &Client,
    current: &Version,
) -> Result<Option<ReleaseVersion>, &'static str> {
    // GitHub's latest-release link redirects to the published release's tag.
    let response = client
        .head(format!("{RELEASES_PAGE}/latest"))
        .send()
        .await
        .map_err(|_| RATE_LIMITED)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_redirection() {
        return Err(RATE_LIMITED);
    }

    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(RATE_LIMITED)?;
    let destination = response.url().join(location).map_err(|_| RATE_LIMITED)?;
    match release_tag_from_redirect(&destination)? {
        Some(tag) => compare_tag(tag, current),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn cmd_check_for_update(app: tauri::AppHandle) -> Result<UpdateCheck, &'static str> {
    let current = &app.package_info().version;
    let client = RELEASE_CLIENT.as_ref().map_err(|_| "无法启动更新检查。")?;
    let response = client
        .get(LATEST_RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "无法连接 GitHub，请检查网络后重试。")?;

    let latest_release = match response.status() {
        StatusCode::OK => response
            .json::<GitHubRelease>()
            .await
            .map_err(|_| "无法读取 GitHub 发布信息，请稍后重试。")?
            .compare(current)?,
        StatusCode::NOT_FOUND => None,
        StatusCode::TOO_MANY_REQUESTS => check_release_page(client, current).await?,
        StatusCode::FORBIDDEN
            if response
                .headers()
                .contains_key(reqwest::header::RETRY_AFTER)
                || response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|value| value == "0") =>
        {
            check_release_page(client, current).await?
        }
        _ => return Err("GitHub 暂时无法提供更新信息，请稍后重试。"),
    };

    Ok(UpdateCheck {
        current_version: current.to_string(),
        latest_release,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions_numerically_and_ignores_build_metadata() {
        let current = Version::parse("1.9.0").unwrap();
        for (tag, is_newer) in [
            ("v1.10.0", true),
            ("v1.8.99", false),
            ("1.9.0+build.7", false),
        ] {
            let release = GitHubRelease {
                tag_name: tag.into(),
                draft: false,
                prerelease: false,
            };
            assert_eq!(
                release.compare(&current).unwrap().unwrap().is_newer,
                is_newer,
                "{tag}"
            );
        }
    }

    #[test]
    fn ignores_drafts_and_prereleases() {
        let current = Version::parse("1.0.0").unwrap();
        for (tag, draft, prerelease) in [
            ("v2.0.0", true, false),
            ("v2.0.0", false, true),
            ("v2.0.0-rc.1", false, false),
        ] {
            let release = GitHubRelease {
                tag_name: tag.into(),
                draft,
                prerelease,
            };
            assert!(release.compare(&current).unwrap().is_none(), "{tag}");
        }
    }

    #[test]
    fn fallback_accepts_only_this_projects_release_redirect() {
        let release = Url::parse(&format!("{RELEASES_PAGE}/tag/v1.10.0")).unwrap();
        let index = Url::parse(RELEASES_PAGE).unwrap();
        let other = Url::parse("https://github.com/Other/Project/releases/tag/v2.0.0").unwrap();
        assert_eq!(release_tag_from_redirect(&release), Ok(Some("v1.10.0")));
        assert_eq!(release_tag_from_redirect(&index), Ok(None));
        assert!(release_tag_from_redirect(&other).is_err());
    }
}

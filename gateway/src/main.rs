mod store;
mod telemetry;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use opentelemetry::{
    Context,
    trace::{FutureExt, TraceContextExt},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use store::Store;
use tokio::sync::Semaphore;

#[derive(Clone)]
struct AppState {
    store: Store,
    client: reqwest::Client,
    analyzer_url: String,
    jobs: Arc<Semaphore>,
}

struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "database operation failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "数据库操作失败。".into())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RunRequest {
    title: String,
    mode: String,
    requested_model: String,
    repetitions: u8,
    api_style: String,
    reasoning_effort: String,
    #[serde(default = "healthy")]
    scenario: String,
}
fn healthy() -> String {
    "healthy".into()
}

fn validate(request: &RunRequest) -> Result<(), ApiError> {
    if request.title.trim().is_empty()
        || request.title.len() > 240
        || request.requested_model.trim().is_empty()
        || request.requested_model.len() > 200
        || !(1..=5).contains(&request.repetitions)
        || !["demo", "live"].contains(&request.mode.as_str())
        || !["responses", "chat"].contains(&request.api_style.as_str())
        || ![
            "default", "none", "minimal", "low", "medium", "high", "xhigh",
        ]
        .contains(&request.reasoning_effort.as_str())
        || !["healthy", "degraded", "rerouted"].contains(&request.scenario.as_str())
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "检测配置无效，请检查模型、重复次数与参数。".into(),
        ));
    }
    Ok(())
}

async fn list_runs(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let mut runs = state.store.list().await?;
    for run in &mut runs {
        if let Some(report) = run.get_mut("report").and_then(Value::as_object_mut) {
            report.remove("samples");
            report.remove("import_summary");
        }
    }
    Ok(Json(
        json!({"runs": runs, "baseline_id":state.store.baseline_id().await?}),
    ))
}

async fn get_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state
        .store
        .get(&id)
        .await?
        .map(Json)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "检测记录不存在。".into()))
}

async fn export_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let run = state
        .store
        .get(&id)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "检测记录不存在。".into()))?;
    let body = serde_json::to_string_pretty(&run)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "报告导出失败。".into()))?;
    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                "application/json; charset=utf-8".to_owned(),
            ),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"codex-drift-{id}.json\""),
            ),
        ],
        body,
    )
        .into_response())
}

async fn create_run(
    State(state): State<AppState>,
    Json(request): Json<RunRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate(&request)?;
    let permit = state.jobs.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "已有两项检测在运行，请稍后重试。".into(),
        )
    })?;
    let baseline_id = state.store.baseline_id().await?;
    let baseline = if let Some(ref id) = baseline_id {
        state
            .store
            .get(id)
            .await?
            .and_then(|r| r.get("report").cloned())
    } else {
        None
    };
    let config = serde_json::to_value(&request).unwrap();
    let run = json!({"id":uuid::Uuid::new_v4().to_string(), "created_at":chrono::Utc::now().to_rfc3339(),
        "title":request.title.trim(), "status":"queued", "config":config, "baseline_id":baseline_id,
        "trace_id":Context::current().span().span_context().trace_id().to_string()});
    state.store.save(&run).await?;
    let mut job = run.clone();
    let mut body = config;
    body.as_object_mut().unwrap().remove("title");
    body["baseline"] = baseline.unwrap_or(Value::Null);
    let context = Context::current();
    tokio::spawn(
        async move {
            let _permit = permit;
            job["status"] = "running".into();
            if let Err(error) = state.store.save(&job).await {
                tracing::error!(%error, "job state write failed");
                return;
            }
            match forward(&state, "/evaluate", &body).await {
                Ok(report) => {
                    job["report"] = report;
                    job["status"] = "completed".into();
                }
                Err(error) => {
                    job["error"] = error.1.into();
                    job["status"] = "failed".into();
                }
            }
            if let Err(error) = state.store.save(&job).await {
                tracing::error!(%error, "job result write failed");
            }
        }
        .with_context(context),
    );
    Ok((StatusCode::ACCEPTED, Json(run)))
}

async fn forward(state: &AppState, path: &str, body: &Value) -> Result<Value, ApiError> {
    let response = telemetry::analyzer_call(
        &state.client,
        &format!("{}{}", state.analyzer_url, path),
        body,
    )
    .await
    .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "分析服务不可用或检测超时。".into()))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "分析服务返回无效响应。".into()))?;
    if !status.is_success() {
        return Err(ApiError(
            if status.is_client_error() {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::BAD_GATEWAY
            },
            payload["detail"]
                .as_str()
                .unwrap_or("分析请求无效。")
                .to_owned(),
        ));
    }
    Ok(payload)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportRequest {
    title: String,
    content: String,
    #[serde(default)]
    expected_model: String,
}
async fn import_run(
    State(state): State<AppState>,
    Json(request): Json<ImportRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if request.title.trim().is_empty()
        || request.title.len() > 240
        || request.content.len() > 2 * 1024 * 1024
        || request.expected_model.len() > 200
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "导入配置无效或文件过大。".into(),
        ));
    }
    let report = forward(
        &state,
        "/analyze-import",
        &json!({"content":request.content,"expected_model":request.expected_model}),
    )
    .await?;
    let run = json!({"id":uuid::Uuid::new_v4().to_string(), "created_at":chrono::Utc::now().to_rfc3339(), "title":request.title.trim(),
        "status":"completed", "config":{"mode":"import","requested_model":request.expected_model}, "report":report,
        "trace_id":Context::current().span().span_context().trace_id().to_string()});
    state.store.save(&run).await?;
    Ok((StatusCode::CREATED, Json(run)))
}

#[derive(Deserialize)]
struct BaselineRequest {
    run_id: String,
}
async fn set_baseline(
    State(state): State<AppState>,
    Json(request): Json<BaselineRequest>,
) -> Result<Json<Value>, ApiError> {
    let run = state
        .store
        .get(&request.run_id)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "记录不存在。".into()))?;
    if run["status"] != "completed"
        || run["config"]["mode"] == "import"
        || run["report"]["error_count"].as_i64() != Some(0)
        || run["report"]["valid_count"].as_i64().unwrap_or(0) == 0
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "只有完整且无接口错误的测试才能作为基线。".into(),
        ));
    }
    state.store.set_baseline(&request.run_id).await?;
    Ok(Json(json!({"baseline_id":request.run_id})))
}

async fn config(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let response = state
        .client
        .get(format!("{}/config", state.analyzer_url))
        .send()
        .await
        .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "分析服务不可用。".into()))?;
    let mut config: Value = response
        .json()
        .await
        .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "分析服务不可用。".into()))?;
    config["database"] = state.store.dialect().into();
    config["baseline_id"] = state
        .store
        .baseline_id()
        .await?
        .map(Value::String)
        .unwrap_or(Value::Null);
    Ok(Json(config))
}
async fn benchmarks(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let response = state
        .client
        .get(format!("{}/benchmarks", state.analyzer_url))
        .send()
        .await
        .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "分析服务不可用。".into()))?;
    Ok(Json(response.json().await.map_err(|_| {
        ApiError(StatusCode::BAD_GATEWAY, "测试集读取失败。".into())
    })?))
}
async fn health(State(state): State<AppState>) -> Json<Value> {
    let analyzer_ok = state
        .client
        .get(format!("{}/health", state.analyzer_url))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    Json(
        json!({"status":if analyzer_ok { "ok" } else { "degraded" }, "analyzer":analyzer_ok,"database":state.store.dialect()}),
    )
}

async fn serve() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    std::fs::create_dir_all("data")?;
    let state = AppState {
        store: Store::connect(
            &std::env::var("DATABASE_URL").unwrap_or("sqlite://data/drift.db?mode=rwc".into()),
        )
        .await?,
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(3600))
            .build()?,
        analyzer_url: std::env::var("ANALYZER_URL")
            .unwrap_or("http://127.0.0.1:8001".into())
            .trim_end_matches('/')
            .into(),
        jobs: Arc::new(Semaphore::new(2)),
    };
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(config))
        .route("/api/benchmarks", get(benchmarks))
        .route("/api/runs", get(list_runs).post(create_run))
        .route("/api/runs/{id}", get(get_run))
        .route("/api/runs/{id}/export", get(export_run))
        .route("/api/import", post(import_run))
        .route("/api/baseline", put(set_baseline))
        .layer(DefaultBodyLimit::max(3 * 1024 * 1024))
        .layer(middleware::from_fn(telemetry::trace_request))
        .with_state(state);
    let bind = std::env::var("API_BIND").unwrap_or("127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind,"Codex Drift API ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let provider = telemetry::initialize()?;
    let result = tokio::runtime::Runtime::new()?.block_on(serve());
    let _ = provider.shutdown();
    result
}

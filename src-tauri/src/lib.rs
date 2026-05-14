use chrono::Utc;
use reqwest::{header::HeaderMap, Method};
use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow},
    Pool, Row, Sqlite,
};
use std::{fs, time::Instant};
use tauri::{Manager, State};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    db: Pool<Sqlite>,
}

#[derive(Debug, Error)]
enum HolamanError {
    #[error("Invalid request URL: {0}")]
    InvalidUrl(String),
    #[error("Unsupported method: {0}")]
    UnsupportedMethod(String),
    #[error("Network error: {0}")]
    Network(String),
    #[error("Storage error: {0}")]
    Storage(String),
    #[error("Serialization error: {0}")]
    Serialization(String),
}

impl Serialize for HolamanError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<sqlx::Error> for HolamanError {
    fn from(value: sqlx::Error) -> Self {
        Self::Storage(value.to_string())
    }
}

impl From<serde_json::Error> for HolamanError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialization(value.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyValueRow {
    id: String,
    enabled: bool,
    key: String,
    value: String,
    description: Option<String>,
    secret: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MockConfig {
    enabled: bool,
    status_code: u16,
    delay_ms: u64,
    headers: Vec<KeyValueRow>,
    body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptConfig {
    enabled: bool,
    pre_request: String,
    post_response: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum BodyMode {
    None,
    Json,
    #[serde(rename = "form-data")]
    FormData,
    #[serde(rename = "x-www-form-urlencoded")]
    FormUrlEncoded,
    Raw,
    Xml,
    Binary,
    Graphql,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestDraft {
    id: Option<String>,
    name: String,
    collection_id: Option<String>,
    method: String,
    url: String,
    params: Vec<KeyValueRow>,
    headers: Vec<KeyValueRow>,
    body_mode: BodyMode,
    body: String,
    timeout_ms: u64,
    environment_id: Option<String>,
    mock_config: Option<MockConfig>,
    scripts: Option<ScriptConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpRequestPayload {
    method: String,
    url: String,
    params: Vec<KeyValueRow>,
    headers: Vec<KeyValueRow>,
    body_mode: BodyMode,
    body: String,
    timeout_ms: u64,
    environment_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpResponsePayload {
    status: u16,
    status_text: String,
    headers: Vec<KeyValueRow>,
    body: String,
    duration_ms: u128,
    size_bytes: usize,
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Collection {
    id: String,
    name: String,
    parent_id: Option<String>,
    created_at: String,
    updated_at: String,
    request_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedRequest {
    id: String,
    name: String,
    collection_id: Option<String>,
    method: String,
    url: String,
    params: Vec<KeyValueRow>,
    headers: Vec<KeyValueRow>,
    body_mode: BodyMode,
    body: String,
    timeout_ms: u64,
    environment_id: Option<String>,
    mock_config: Option<MockConfig>,
    scripts: Option<ScriptConfig>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HolamanRequestExport {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    request: SavedRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HolamanCollectionExport {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    collection: Collection,
    children: Vec<HolamanCollectionExport>,
    requests: Vec<SavedRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Variable {
    id: String,
    key: String,
    value: String,
    enabled: bool,
    secret: bool,
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Environment {
    id: String,
    name: String,
    variables: Vec<Variable>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    id: String,
    method: String,
    url: String,
    status: Option<u16>,
    duration_ms: Option<u128>,
    created_at: String,
    draft: RequestDraft,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    id: String,
    request_id: Option<String>,
    request_name: Option<String>,
    method: Option<String>,
    url: Option<String>,
    status: Option<i64>,
    duration_ms: Option<i64>,
    size_bytes: Option<i64>,
    level: String,
    stage: String,
    message: String,
    request_body: Option<String>,
    response_body: Option<String>,
    created_at: String,
}

#[tauri::command]
async fn send_http_request(
    state: State<'_, AppState>,
    payload: HttpRequestPayload,
) -> Result<HttpResponsePayload, HolamanError> {
    let payload = resolve_payload_variables(&state.db, payload).await?;
    let mut url = Url::parse(&payload.url).map_err(|error| HolamanError::InvalidUrl(error.to_string()))?;

    {
        let mut query = url.query_pairs_mut();
        for row in payload.params.iter().filter(|row| row.enabled && !row.key.is_empty()) {
            query.append_pair(&row.key, &row.value);
        }
    }

    let method = Method::from_bytes(payload.method.as_bytes())
        .map_err(|_| HolamanError::UnsupportedMethod(payload.method.clone()))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(payload.timeout_ms.max(1)))
        .build()
        .map_err(|error| HolamanError::Network(error.to_string()))?;

    let mut request = client.request(method.clone(), url.clone());
    for row in payload.headers.iter().filter(|row| row.enabled && !row.key.is_empty()) {
        request = request.header(&row.key, &row.value);
    }

    request = match payload.body_mode {
        BodyMode::None => request,
        BodyMode::Json => request
            .header("content-type", "application/json")
            .body(payload.body.clone()),
        BodyMode::Raw | BodyMode::Xml | BodyMode::Graphql => request.body(payload.body.clone()),
        BodyMode::FormUrlEncoded => {
            let fields = parse_form_encoded(&payload.body);
            request.form(&fields)
        }
        BodyMode::FormData | BodyMode::Binary => request.body(payload.body.clone()),
    };

    let started = Instant::now();
    let response = request
        .send()
        .await
        .map_err(|error| HolamanError::Network(error.to_string()))?;
    let status = response.status();
    let headers = headers_to_rows(response.headers());
    let final_url = response.url().to_string();
    let body = response
        .text()
        .await
        .map_err(|error| HolamanError::Network(error.to_string()))?;

    Ok(HttpResponsePayload {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        size_bytes: body.as_bytes().len(),
        body,
        headers,
        duration_ms: started.elapsed().as_millis(),
        url: final_url,
    })
}

#[tauri::command]
async fn list_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, HolamanError> {
    let rows = sqlx::query(
        r#"
        select c.id, c.name, c.parent_id, c.created_at, c.updated_at, count(r.id) as request_count
        from collections c
        left join requests r on r.collection_id = c.id
        group by c.id, c.name, c.parent_id, c.created_at, c.updated_at
        order by c.updated_at desc
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| Collection {
            id: row.get("id"),
            name: row.get("name"),
            parent_id: row.get("parent_id"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            request_count: row.get("request_count"),
        })
        .collect())
}

#[tauri::command]
async fn save_collection(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<Collection, HolamanError> {
    let now = Utc::now().to_rfc3339();
    let id = new_id();
    let name = normalize_collection_name(name);

    sqlx::query("insert into collections (id, name, parent_id, created_at, updated_at) values (?1, ?2, ?3, ?4, ?4)")
        .bind(&id)
        .bind(&name)
        .bind(&parent_id)
        .bind(&now)
        .execute(&state.db)
        .await?;

    Ok(Collection {
        id,
        name,
        parent_id,
        created_at: now.clone(),
        updated_at: now,
        request_count: 0,
    })
}

#[tauri::command]
async fn rename_collection(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<Collection, HolamanError> {
    let now = Utc::now().to_rfc3339();
    let name = normalize_collection_name(name);

    sqlx::query("update collections set name = ?1, updated_at = ?2 where id = ?3")
        .bind(&name)
        .bind(&now)
        .bind(&id)
        .execute(&state.db)
        .await?;

    let request_count: i64 = sqlx::query_scalar("select count(*) from requests where collection_id = ?1")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;

    let row = sqlx::query("select parent_id, created_at from collections where id = ?1")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;

    Ok(Collection {
        id,
        name,
        parent_id: row.get("parent_id"),
        created_at: row.get("created_at"),
        updated_at: now,
        request_count,
    })
}

#[tauri::command]
async fn delete_collection(state: State<'_, AppState>, id: String) -> Result<(), HolamanError> {
    let ids = collection_descendant_ids(&state.db, &id).await?;
    for collection_id in ids.iter().rev() {
        sqlx::query("delete from requests where collection_id = ?1")
            .bind(collection_id)
            .execute(&state.db)
            .await?;
    }
    for collection_id in ids.iter().rev() {
        sqlx::query("delete from collections where id = ?1")
            .bind(collection_id)
            .execute(&state.db)
            .await?;
    }
    Ok(())
}

#[tauri::command]
async fn move_collection(
    state: State<'_, AppState>,
    id: String,
    parent_id: Option<String>,
) -> Result<(), HolamanError> {
    if parent_id.as_deref() == Some(id.as_str()) {
        return Err(HolamanError::Storage("不能将集合移动到自身下".to_string()));
    }

    let descendants = collection_descendant_ids(&state.db, &id).await?;
    if let Some(parent_id) = &parent_id {
        if descendants.iter().any(|item| item == parent_id) {
            return Err(HolamanError::Storage("不能将集合移动到自己的子集合下".to_string()));
        }
    }

    let now = Utc::now().to_rfc3339();
    sqlx::query("update collections set parent_id = ?1, updated_at = ?2 where id = ?3")
        .bind(&parent_id)
        .bind(&now)
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
async fn move_request(
    state: State<'_, AppState>,
    id: String,
    collection_id: Option<String>,
) -> Result<(), HolamanError> {
    let now = Utc::now().to_rfc3339();
    sqlx::query("update requests set collection_id = ?1, updated_at = ?2 where id = ?3")
        .bind(&collection_id)
        .bind(&now)
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
async fn delete_request(state: State<'_, AppState>, id: String) -> Result<(), HolamanError> {
    sqlx::query("delete from requests where id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
async fn list_requests(
    state: State<'_, AppState>,
    collection_id: Option<String>,
) -> Result<Vec<SavedRequest>, HolamanError> {
    let rows = sqlx::query(
        r#"
        select id, collection_id, name, method, url, params_json, headers_json, body_mode, body,
               timeout_ms, environment_id, mock_config_json, scripts_json, created_at, updated_at
        from requests
        where (collection_id = ?1) or (collection_id is null and ?1 is null)
        order by updated_at desc
        "#,
    )
    .bind(collection_id)
    .fetch_all(&state.db)
    .await?;

    rows.into_iter()
        .map(|row| {
            let params_json: String = row.get("params_json");
            let headers_json: String = row.get("headers_json");
            let body_mode_json: String = row.get("body_mode");
            let mock_config_json: Option<String> = row.get("mock_config_json");
            let scripts_json: Option<String> = row.get("scripts_json");
            Ok(SavedRequest {
                id: row.get("id"),
                collection_id: row.get("collection_id"),
                name: row.get("name"),
                method: row.get("method"),
                url: row.get("url"),
                params: serde_json::from_str(&params_json)?,
                headers: serde_json::from_str(&headers_json)?,
                body_mode: serde_json::from_str(&body_mode_json)?,
                body: row.get("body"),
                timeout_ms: row.get::<i64, _>("timeout_ms") as u64,
                environment_id: row.get("environment_id"),
                mock_config: mock_config_json
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?,
                scripts: scripts_json
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?,
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
            })
        })
        .collect()
}

#[tauri::command]
async fn save_request(
    state: State<'_, AppState>,
    request: RequestDraft,
) -> Result<SavedRequest, HolamanError> {
    let now = Utc::now().to_rfc3339();
    let request_id = request.id.clone().unwrap_or_else(new_id);
    let collection_id = request.collection_id.clone();

    if let Some(collection_id) = &collection_id {
        sqlx::query(
            r#"
            insert into collections (id, name, parent_id, created_at, updated_at)
            values (?1, '本地集合', null, ?2, ?2)
            on conflict(id) do update set updated_at = excluded.updated_at
            "#,
        )
        .bind(collection_id)
        .bind(&now)
        .execute(&state.db)
        .await?;
    }

    sqlx::query(
        r#"
        insert into requests
        (id, collection_id, name, method, url, params_json, headers_json, body_mode, body, timeout_ms, environment_id, mock_config_json, scripts_json, created_at, updated_at)
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
        on conflict(id) do update set
        collection_id = excluded.collection_id,
        name = excluded.name,
        method = excluded.method,
        url = excluded.url,
        params_json = excluded.params_json,
        headers_json = excluded.headers_json,
        body_mode = excluded.body_mode,
        body = excluded.body,
        timeout_ms = excluded.timeout_ms,
        environment_id = excluded.environment_id,
        mock_config_json = excluded.mock_config_json,
        scripts_json = excluded.scripts_json,
        updated_at = excluded.updated_at
        "#,
    )
    .bind(&request_id)
    .bind(&collection_id)
    .bind(&request.name)
    .bind(&request.method)
    .bind(&request.url)
    .bind(serde_json::to_string(&request.params)?)
    .bind(serde_json::to_string(&request.headers)?)
    .bind(serde_json::to_string(&request.body_mode)?)
    .bind(&request.body)
    .bind(request.timeout_ms as i64)
    .bind(&request.environment_id)
    .bind(
        request
            .mock_config
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
    )
    .bind(
        request
            .scripts
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
    )
    .bind(&now)
    .execute(&state.db)
    .await?;

    Ok(SavedRequest {
        id: request_id,
        name: request.name,
        collection_id,
        method: request.method,
        url: request.url,
        params: request.params,
        headers: request.headers,
        body_mode: request.body_mode,
        body: request.body,
        timeout_ms: request.timeout_ms,
        environment_id: request.environment_id,
        mock_config: request.mock_config,
        scripts: request.scripts,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
async fn export_request(
    state: State<'_, AppState>,
    id: String,
) -> Result<HolamanRequestExport, HolamanError> {
    Ok(HolamanRequestExport {
        kind: "holaman.request".to_string(),
        version: 1,
        request: fetch_request(&state.db, &id).await?,
    })
}

#[tauri::command]
async fn import_request(
    state: State<'_, AppState>,
    payload: HolamanRequestExport,
    collection_id: Option<String>,
) -> Result<SavedRequest, HolamanError> {
    let mut request = payload.request;
    request.id = new_id();
    request.collection_id = collection_id;
    request.created_at = Utc::now().to_rfc3339();
    request.updated_at = request.created_at.clone();
    insert_saved_request(&state.db, &request).await?;
    Ok(request)
}

#[tauri::command]
async fn export_collection(
    state: State<'_, AppState>,
    id: String,
) -> Result<HolamanCollectionExport, HolamanError> {
    let collections = fetch_all_collections(&state.db).await?;
    let requests = fetch_all_requests(&state.db).await?;
    let Some(collection) = collections.iter().find(|collection| collection.id == id) else {
        return Err(HolamanError::Storage("集合不存在".to_string()));
    };

    Ok(build_collection_export(collection, &collections, &requests))
}

#[tauri::command]
async fn import_collection(
    state: State<'_, AppState>,
    payload: HolamanCollectionExport,
    parent_id: Option<String>,
) -> Result<Collection, HolamanError> {
    let now = Utc::now().to_rfc3339();
    let mut collections = Vec::new();
    let mut requests = Vec::new();
    flatten_collection_import(&payload, parent_id, &now, &mut collections, &mut requests);
    let Some(root) = collections.first().cloned() else {
        return Err(HolamanError::Storage("集合结构为空".to_string()));
    };

    for collection in &collections {
        insert_collection(&state.db, collection).await?;
    }
    for request in &requests {
        insert_saved_request(&state.db, request).await?;
    }

    Ok(root)
}

#[tauri::command]
async fn list_history(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>, HolamanError> {
    let rows = sqlx::query(
        "select id, method, url, status, duration_ms, created_at, draft_json from request_history order by created_at desc limit 80",
    )
    .fetch_all(&state.db)
    .await?;

    rows.into_iter()
        .map(|row| {
            let draft_json: String = row.get("draft_json");
            Ok(HistoryEntry {
                id: row.get("id"),
                method: row.get("method"),
                url: row.get("url"),
                status: row.try_get::<i64, _>("status").ok().map(|value| value as u16),
                duration_ms: row.try_get::<i64, _>("duration_ms").ok().map(|value| value as u128),
                created_at: row.get("created_at"),
                draft: serde_json::from_str(&draft_json)?,
            })
        })
        .collect()
}

#[tauri::command]
async fn save_history_entry(
    state: State<'_, AppState>,
    entry: HistoryEntry,
) -> Result<HistoryEntry, HolamanError> {
    sqlx::query(
        r#"
        insert into request_history
        (id, method, url, status, duration_ms, created_at, draft_json)
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind(&entry.id)
    .bind(&entry.method)
    .bind(&entry.url)
    .bind(entry.status.map(|value| value as i64))
    .bind(entry.duration_ms.map(|value| value as i64))
    .bind(&entry.created_at)
    .bind(serde_json::to_string(&entry.draft)?)
    .execute(&state.db)
    .await?;

    Ok(entry)
}

#[tauri::command]
async fn list_logs(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<LogEntry>, HolamanError> {
    let limit = limit.unwrap_or(300).clamp(1, 2000);
    let rows = sqlx::query(
        r#"
        select id, request_id, request_name, method, url, status, duration_ms, size_bytes,
               level, stage, message, request_body, response_body, created_at
        from app_logs
        order by created_at asc
        limit ?1
        "#,
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| LogEntry {
            id: row.get("id"),
            request_id: row.get("request_id"),
            request_name: row.get("request_name"),
            method: row.get("method"),
            url: row.get("url"),
            status: row.get("status"),
            duration_ms: row.get("duration_ms"),
            size_bytes: row.get("size_bytes"),
            level: row.get("level"),
            stage: row.get("stage"),
            message: row.get("message"),
            request_body: row.get("request_body"),
            response_body: row.get("response_body"),
            created_at: row.get("created_at"),
        })
        .collect())
}

#[tauri::command]
async fn save_log(
    state: State<'_, AppState>,
    mut entry: LogEntry,
) -> Result<LogEntry, HolamanError> {
    if entry.id.trim().is_empty() {
        entry.id = new_id();
    }
    if entry.created_at.trim().is_empty() {
        entry.created_at = Utc::now().to_rfc3339();
    }

    sqlx::query(
        r#"
        insert into app_logs
        (id, request_id, request_name, method, url, status, duration_ms, size_bytes,
         level, stage, message, request_body, response_body, created_at)
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        "#,
    )
    .bind(&entry.id)
    .bind(&entry.request_id)
    .bind(&entry.request_name)
    .bind(&entry.method)
    .bind(&entry.url)
    .bind(entry.status)
    .bind(entry.duration_ms)
    .bind(entry.size_bytes)
    .bind(&entry.level)
    .bind(&entry.stage)
    .bind(&entry.message)
    .bind(&entry.request_body)
    .bind(&entry.response_body)
    .bind(&entry.created_at)
    .execute(&state.db)
    .await?;

    Ok(entry)
}

#[tauri::command]
async fn clear_logs(state: State<'_, AppState>) -> Result<(), HolamanError> {
    sqlx::query("delete from app_logs")
        .execute(&state.db)
        .await?;
    Ok(())
}

#[tauri::command]
async fn list_environments(state: State<'_, AppState>) -> Result<Vec<Environment>, HolamanError> {
    let rows = sqlx::query("select id, name, variables_json, created_at, updated_at from environments order by name asc")
        .fetch_all(&state.db)
        .await?;

    rows.into_iter()
        .map(|row| {
            let variables_json: String = row.get("variables_json");
            Ok(Environment {
                id: row.get("id"),
                name: row.get("name"),
                variables: serde_json::from_str(&variables_json)?,
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
            })
        })
        .collect()
}

#[tauri::command]
async fn save_environment(
    state: State<'_, AppState>,
    environment: Environment,
) -> Result<Environment, HolamanError> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        insert into environments (id, name, variables_json, created_at, updated_at)
        values (?1, ?2, ?3, ?4, ?4)
        on conflict(id) do update set
        name = excluded.name,
        variables_json = excluded.variables_json,
        updated_at = excluded.updated_at
        "#,
    )
    .bind(&environment.id)
    .bind(&environment.name)
    .bind(serde_json::to_string(&environment.variables)?)
    .bind(&now)
    .execute(&state.db)
    .await?;

    Ok(Environment {
        updated_at: now,
        ..environment
    })
}

#[tauri::command]
async fn delete_environment(state: State<'_, AppState>, id: String) -> Result<(), HolamanError> {
    sqlx::query("delete from environments where id = ?1")
        .bind(id)
        .execute(&state.db)
        .await?;

    Ok(())
}

async fn init_db(app: &tauri::App) -> Result<Pool<Sqlite>, HolamanError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| HolamanError::Storage(error.to_string()))?;
    fs::create_dir_all(&app_data_dir).map_err(|error| HolamanError::Storage(error.to_string()))?;
    let db_path = app_data_dir.join("holaman.sqlite");
    let connect_options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true);
    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(connect_options)
        .await?;

    migrate(&db).await?;
    ensure_default_environment(&db).await?;
    ensure_default_workspace(&db).await?;
    Ok(db)
}

async fn migrate(db: &Pool<Sqlite>) -> Result<(), HolamanError> {
    sqlx::query(
        r#"
        create table if not exists collections (
            id text primary key,
            name text not null,
            parent_id text,
            created_at text not null,
            updated_at text not null
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        create table if not exists requests (
            id text primary key,
            collection_id text,
            name text not null,
            method text not null,
            url text not null,
            params_json text not null,
            headers_json text not null,
            body_mode text not null,
            body text not null,
            timeout_ms integer not null,
            environment_id text,
            mock_config_json text,
            scripts_json text,
            created_at text not null,
            updated_at text not null
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        create table if not exists environments (
            id text primary key,
            name text not null,
            variables_json text not null,
            created_at text not null,
            updated_at text not null
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        create table if not exists request_history (
            id text primary key,
            method text not null,
            url text not null,
            status integer,
            duration_ms integer,
            created_at text not null,
            draft_json text not null
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        create table if not exists app_logs (
            id text primary key,
            request_id text,
            request_name text,
            method text,
            url text,
            status integer,
            duration_ms integer,
            size_bytes integer,
            level text not null,
            stage text not null,
            message text not null,
            request_body text,
            response_body text,
            created_at text not null
        );
        "#,
    )
    .execute(db)
    .await?;

    ensure_collection_parent_column(db).await?;
    ensure_nullable_request_collection(db).await?;
    ensure_request_mock_config_column(db).await?;
    ensure_request_scripts_column(db).await?;

    Ok(())
}

async fn ensure_request_scripts_column(db: &Pool<Sqlite>) -> Result<(), HolamanError> {
    let rows = sqlx::query("pragma table_info(requests)")
        .fetch_all(db)
        .await?;
    let has_scripts = rows.iter().any(|row| row.get::<String, _>("name") == "scripts_json");

    if !has_scripts {
        sqlx::query("alter table requests add column scripts_json text")
            .execute(db)
            .await?;
    }

    Ok(())
}

async fn ensure_request_mock_config_column(db: &Pool<Sqlite>) -> Result<(), HolamanError> {
    let rows = sqlx::query("pragma table_info(requests)")
        .fetch_all(db)
        .await?;
    let has_mock_config = rows.iter().any(|row| row.get::<String, _>("name") == "mock_config_json");

    if !has_mock_config {
        sqlx::query("alter table requests add column mock_config_json text")
            .execute(db)
            .await?;
    }

    Ok(())
}

async fn ensure_collection_parent_column(db: &Pool<Sqlite>) -> Result<(), HolamanError> {
    let rows = sqlx::query("pragma table_info(collections)")
        .fetch_all(db)
        .await?;
    let has_parent_id = rows.iter().any(|row| row.get::<String, _>("name") == "parent_id");

    if !has_parent_id {
        sqlx::query("alter table collections add column parent_id text")
            .execute(db)
            .await?;
    }

    Ok(())
}

async fn ensure_nullable_request_collection(db: &Pool<Sqlite>) -> Result<(), HolamanError> {
    let rows = sqlx::query("pragma table_info(requests)")
        .fetch_all(db)
        .await?;
    let collection_is_not_null = rows.iter().any(|row| {
        row.get::<String, _>("name") == "collection_id" && row.get::<i64, _>("notnull") == 1
    });

    if !collection_is_not_null {
        return Ok(());
    }

    sqlx::query("alter table requests rename to requests_old")
        .execute(db)
        .await?;
    sqlx::query(
        r#"
        create table requests (
            id text primary key,
            collection_id text,
            name text not null,
            method text not null,
            url text not null,
            params_json text not null,
            headers_json text not null,
            body_mode text not null,
            body text not null,
            timeout_ms integer not null,
            environment_id text,
            created_at text not null,
            updated_at text not null
        );
        "#,
    )
    .execute(db)
    .await?;
    sqlx::query(
        r#"
        insert into requests
        (id, collection_id, name, method, url, params_json, headers_json, body_mode, body, timeout_ms, environment_id, created_at, updated_at)
        select id, collection_id, name, method, url, params_json, headers_json, body_mode, body, timeout_ms, environment_id, created_at, updated_at
        from requests_old
        "#,
    )
    .execute(db)
    .await?;
    sqlx::query("drop table requests_old").execute(db).await?;

    Ok(())
}

async fn ensure_default_environment(db: &Pool<Sqlite>) -> Result<(), HolamanError> {
    let count: (i64,) = sqlx::query_as("select count(*) from environments")
        .fetch_one(db)
        .await?;

    if count.0 > 0 {
        return Ok(());
    }

    let now = Utc::now().to_rfc3339();
    let variables = vec![Variable {
        id: new_id(),
        key: "base_url".to_string(),
        value: "https://httpbin.org".to_string(),
        enabled: true,
        secret: false,
        description: Some("默认开发环境 API 基础地址".to_string()),
    }];

    sqlx::query(
        "insert into environments (id, name, variables_json, created_at, updated_at) values ('dev', '开发环境', ?1, ?2, ?2)",
    )
    .bind(serde_json::to_string(&variables)?)
    .bind(now)
    .execute(db)
    .await?;

    Ok(())
}

async fn ensure_default_workspace(db: &Pool<Sqlite>) -> Result<(), HolamanError> {
    let collection_count: i64 = sqlx::query_scalar("select count(*) from collections")
        .fetch_one(db)
        .await?;
    let request_count: i64 = sqlx::query_scalar("select count(*) from requests")
        .fetch_one(db)
        .await?;

    if collection_count > 0 || request_count > 0 {
        return Ok(());
    }

    let now = Utc::now().to_rfc3339();
    let params = vec![KeyValueRow {
        id: new_id(),
        enabled: true,
        key: String::new(),
        value: String::new(),
        description: Some(String::new()),
        secret: Some(false),
    }];
    let headers = vec![KeyValueRow {
        id: new_id(),
        enabled: true,
        key: "Accept".to_string(),
        value: "application/json".to_string(),
        description: Some("默认响应格式".to_string()),
        secret: Some(false),
    }];

    sqlx::query("insert into collections (id, name, parent_id, created_at, updated_at) values ('local', '本地集合', null, ?1, ?1)")
        .bind(&now)
        .execute(db)
        .await?;

    sqlx::query(
        r#"
        insert into requests
        (id, collection_id, name, method, url, params_json, headers_json, body_mode, body, timeout_ms, environment_id, mock_config_json, scripts_json, created_at, updated_at)
        values ('default-httpbin-get', 'local', '示例请求', 'GET', 'https://httpbin.org/get', ?1, ?2, ?3, '', 30000, 'dev', null, null, ?4, ?4)
        "#,
    )
    .bind(serde_json::to_string(&params)?)
    .bind(serde_json::to_string(&headers)?)
    .bind(serde_json::to_string(&BodyMode::None)?)
    .bind(&now)
    .execute(db)
    .await?;

    Ok(())
}

async fn fetch_request(db: &Pool<Sqlite>, id: &str) -> Result<SavedRequest, HolamanError> {
    let row = sqlx::query(
        r#"
        select id, collection_id, name, method, url, params_json, headers_json, body_mode, body,
               timeout_ms, environment_id, mock_config_json, scripts_json, created_at, updated_at
        from requests
        where id = ?1
        "#,
    )
    .bind(id)
    .fetch_one(db)
    .await?;

    row_to_saved_request(row)
}

async fn fetch_all_requests(db: &Pool<Sqlite>) -> Result<Vec<SavedRequest>, HolamanError> {
    let rows = sqlx::query(
        r#"
        select id, collection_id, name, method, url, params_json, headers_json, body_mode, body,
               timeout_ms, environment_id, mock_config_json, scripts_json, created_at, updated_at
        from requests
        order by updated_at desc
        "#,
    )
    .fetch_all(db)
    .await?;

    rows.into_iter().map(row_to_saved_request).collect()
}

async fn fetch_all_collections(db: &Pool<Sqlite>) -> Result<Vec<Collection>, HolamanError> {
    let rows = sqlx::query(
        r#"
        select c.id, c.name, c.parent_id, c.created_at, c.updated_at, count(r.id) as request_count
        from collections c
        left join requests r on r.collection_id = c.id
        group by c.id, c.name, c.parent_id, c.created_at, c.updated_at
        order by c.updated_at desc
        "#,
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| Collection {
            id: row.get("id"),
            name: row.get("name"),
            parent_id: row.get("parent_id"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            request_count: row.get("request_count"),
        })
        .collect())
}

fn row_to_saved_request(row: SqliteRow) -> Result<SavedRequest, HolamanError> {
    let params_json: String = row.get("params_json");
    let headers_json: String = row.get("headers_json");
    let body_mode_json: String = row.get("body_mode");
    let mock_config_json: Option<String> = row.get("mock_config_json");
    let scripts_json: Option<String> = row.get("scripts_json");
    Ok(SavedRequest {
        id: row.get("id"),
        collection_id: row.get("collection_id"),
        name: row.get("name"),
        method: row.get("method"),
        url: row.get("url"),
        params: serde_json::from_str(&params_json)?,
        headers: serde_json::from_str(&headers_json)?,
        body_mode: serde_json::from_str(&body_mode_json)?,
        body: row.get("body"),
        timeout_ms: row.get::<i64, _>("timeout_ms") as u64,
        environment_id: row.get("environment_id"),
        mock_config: mock_config_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?,
        scripts: scripts_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

async fn insert_collection(db: &Pool<Sqlite>, collection: &Collection) -> Result<(), HolamanError> {
    sqlx::query(
        r#"
        insert into collections (id, name, parent_id, created_at, updated_at)
        values (?1, ?2, ?3, ?4, ?5)
        on conflict(id) do update set
        name = excluded.name,
        parent_id = excluded.parent_id,
        updated_at = excluded.updated_at
        "#,
    )
    .bind(&collection.id)
    .bind(&collection.name)
    .bind(&collection.parent_id)
    .bind(&collection.created_at)
    .bind(&collection.updated_at)
    .execute(db)
    .await?;
    Ok(())
}

async fn insert_saved_request(db: &Pool<Sqlite>, request: &SavedRequest) -> Result<(), HolamanError> {
    sqlx::query(
        r#"
        insert into requests
        (id, collection_id, name, method, url, params_json, headers_json, body_mode, body, timeout_ms, environment_id, mock_config_json, scripts_json, created_at, updated_at)
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        on conflict(id) do update set
        collection_id = excluded.collection_id,
        name = excluded.name,
        method = excluded.method,
        url = excluded.url,
        params_json = excluded.params_json,
        headers_json = excluded.headers_json,
        body_mode = excluded.body_mode,
        body = excluded.body,
        timeout_ms = excluded.timeout_ms,
        environment_id = excluded.environment_id,
        mock_config_json = excluded.mock_config_json,
        scripts_json = excluded.scripts_json,
        updated_at = excluded.updated_at
        "#,
    )
    .bind(&request.id)
    .bind(&request.collection_id)
    .bind(&request.name)
    .bind(&request.method)
    .bind(&request.url)
    .bind(serde_json::to_string(&request.params)?)
    .bind(serde_json::to_string(&request.headers)?)
    .bind(serde_json::to_string(&request.body_mode)?)
    .bind(&request.body)
    .bind(request.timeout_ms as i64)
    .bind(&request.environment_id)
    .bind(
        request
            .mock_config
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
    )
    .bind(
        request
            .scripts
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
    )
    .bind(&request.created_at)
    .bind(&request.updated_at)
    .execute(db)
    .await?;
    Ok(())
}

fn build_collection_export(
    collection: &Collection,
    collections: &[Collection],
    requests: &[SavedRequest],
) -> HolamanCollectionExport {
    let children = collections
        .iter()
        .filter(|child| child.parent_id.as_deref() == Some(collection.id.as_str()))
        .map(|child| build_collection_export(child, collections, requests))
        .collect();
    let requests = requests
        .iter()
        .filter(|request| request.collection_id.as_deref() == Some(collection.id.as_str()))
        .cloned()
        .collect();

    HolamanCollectionExport {
        kind: "holaman.collection".to_string(),
        version: 1,
        collection: collection.clone(),
        children,
        requests,
    }
}

fn flatten_collection_import(
    payload: &HolamanCollectionExport,
    parent_id: Option<String>,
    now: &str,
    collections: &mut Vec<Collection>,
    requests: &mut Vec<SavedRequest>,
) {
    let new_collection_id = new_id();

    collections.push(Collection {
        id: new_collection_id.clone(),
        name: normalize_collection_name(payload.collection.name.clone()),
        parent_id,
        created_at: now.to_string(),
        updated_at: now.to_string(),
        request_count: payload.requests.len() as i64,
    });

    for request in &payload.requests {
        let mut request = request.clone();
        request.id = new_id();
        request.collection_id = Some(new_collection_id.clone());
        request.created_at = now.to_string();
        request.updated_at = now.to_string();
        requests.push(request);
    }

    for child in &payload.children {
        flatten_collection_import(child, Some(new_collection_id.clone()), now, collections, requests);
    }
}

async fn collection_descendant_ids(db: &Pool<Sqlite>, id: &str) -> Result<Vec<String>, HolamanError> {
    let collections = fetch_all_collections(db).await?;
    let mut ids = vec![id.to_string()];
    let mut index = 0;
    while index < ids.len() {
        let current_id = ids[index].clone();
        for collection in collections
            .iter()
            .filter(|collection| collection.parent_id.as_deref() == Some(current_id.as_str()))
        {
            if !ids.iter().any(|item| item == &collection.id) {
                ids.push(collection.id.clone());
            }
        }
        index += 1;
    }

    Ok(ids)
}

async fn resolve_payload_variables(
    db: &Pool<Sqlite>,
    mut payload: HttpRequestPayload,
) -> Result<HttpRequestPayload, HolamanError> {
    let Some(environment_id) = &payload.environment_id else {
        return Ok(payload);
    };
    let Some(row) = sqlx::query("select variables_json from environments where id = ?1")
        .bind(environment_id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(payload);
    };

    let variables_json: String = row.get("variables_json");
    let variables: Vec<Variable> = serde_json::from_str(&variables_json)?;

    for variable in variables.into_iter().filter(|variable| variable.enabled) {
        let token = format!("{{{{{}}}}}", variable.key);
        payload.url = payload.url.replace(&token, &variable.value);
        payload.body = payload.body.replace(&token, &variable.value);
        for row in payload.params.iter_mut().chain(payload.headers.iter_mut()) {
            row.value = row.value.replace(&token, &variable.value);
        }
    }

    Ok(payload)
}

fn headers_to_rows(headers: &HeaderMap) -> Vec<KeyValueRow> {
    headers
        .iter()
        .map(|(key, value)| KeyValueRow {
            id: new_id(),
            enabled: true,
            key: key.to_string(),
            value: value.to_str().unwrap_or("").to_string(),
            description: None,
            secret: Some(false),
        })
        .collect()
}

fn parse_form_encoded(body: &str) -> Vec<(String, String)> {
    body.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect()
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn normalize_collection_name(name: String) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "未命名集合".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let db = tauri::async_runtime::block_on(init_db(app))?;
            app.manage(AppState { db });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_http_request,
            list_collections,
            save_collection,
            rename_collection,
            delete_collection,
            move_collection,
            delete_request,
            move_request,
            list_requests,
            save_request,
            export_collection,
            import_collection,
            export_request,
            import_request,
            list_history,
            save_history_entry,
            list_logs,
            save_log,
            clear_logs,
            list_environments,
            save_environment,
            delete_environment
        ])
        .run(tauri::generate_context!())
        .expect("error while running Holaman");
}

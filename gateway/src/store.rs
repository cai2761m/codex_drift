use serde_json::Value;
use sqlx::{AnyPool, Row, any::AnyPoolOptions};

#[derive(Clone)]
pub struct Store {
    pool: AnyPool,
    postgres: bool,
}

impl Store {
    pub async fn connect(url: &str) -> Result<Self, sqlx::Error> {
        sqlx::any::install_default_drivers();
        // AnyConnectOptions parses through URL first. Encode a Windows drive colon
        // so it cannot be interpreted (and dropped) as an authority port delimiter.
        let normalized = if cfg!(windows) {
            if let Some(path) = url.strip_prefix("sqlite://") {
                if path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic()
                {
                    format!("sqlite://{}%3A{}", &path[..1], &path[2..])
                } else {
                    url.to_owned()
                }
            } else {
                url.to_owned()
            }
        } else {
            url.to_owned()
        };
        let store = Self {
            pool: AnyPoolOptions::new()
                .max_connections(if url.starts_with("sqlite:") { 1 } else { 5 })
                .connect(&normalized)
                .await?,
            postgres: url.starts_with("postgres"),
        };
        for statement in [
            "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at)",
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        ] {
            sqlx::query(statement).execute(&store.pool).await?;
        }
        // In-process jobs cannot survive a restart. Preserve the record and make failure explicit.
        let pending = sqlx::query("SELECT payload FROM runs WHERE status IN ('queued','running')")
            .fetch_all(&store.pool)
            .await?;
        for row in pending {
            let Some(mut run) =
                serde_json::from_str::<Value>(&row.get::<String, _>("payload")).ok()
            else {
                continue;
            };
            if matches!(run["status"].as_str(), Some("queued" | "running")) {
                run["status"] = "failed".into();
                run["error"] = "服务重启中断了检测，请重新运行。".into();
                store.save(&run).await?;
            }
        }
        Ok(store)
    }

    pub fn dialect(&self) -> &str {
        if self.postgres {
            "PostgreSQL"
        } else {
            "SQLite"
        }
    }

    fn sql(&self, query: &str) -> String {
        if !self.postgres {
            return query.to_owned();
        }
        let mut index = 0;
        query
            .chars()
            .map(|c| {
                if c == '?' {
                    index += 1;
                    format!("${index}")
                } else {
                    c.to_string()
                }
            })
            .collect()
    }

    pub async fn save(&self, run: &Value) -> Result<(), sqlx::Error> {
        sqlx::query(&self.sql("INSERT INTO runs (id,created_at,status,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload"))
            .bind(run["id"].as_str().unwrap_or_default())
            .bind(run["created_at"].as_str().unwrap_or_default())
            .bind(run["status"].as_str().unwrap_or_default())
            .bind(run.to_string()).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn get(&self, id: &str) -> Result<Option<Value>, sqlx::Error> {
        let row = sqlx::query(&self.sql("SELECT payload FROM runs WHERE id=?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.and_then(|r| serde_json::from_str(&r.get::<String, _>("payload")).ok()))
    }

    pub async fn list(&self) -> Result<Vec<Value>, sqlx::Error> {
        let rows = sqlx::query("SELECT payload FROM runs ORDER BY created_at DESC LIMIT 100")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| serde_json::from_str(&r.get::<String, _>("payload")).ok())
            .collect())
    }

    pub async fn baseline_id(&self) -> Result<Option<String>, sqlx::Error> {
        Ok(
            sqlx::query("SELECT value FROM settings WHERE key='baseline'")
                .fetch_optional(&self.pool)
                .await?
                .map(|r| r.get("value")),
        )
    }

    pub async fn set_baseline(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query(&self.sql("INSERT INTO settings (key,value) VALUES ('baseline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"))
            .bind(id).execute(&self.pool).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn sqlite_persistence_and_baseline() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let mut run = json!({"id":"a", "created_at":"2026-01-01", "status":"queued"});
        store.save(&run).await.unwrap();
        run["status"] = "completed".into();
        store.save(&run).await.unwrap();
        assert_eq!(
            store.get("a").await.unwrap().unwrap()["status"],
            "completed"
        );
        assert_eq!(store.list().await.unwrap().len(), 1);
        store.set_baseline("a").await.unwrap();
        assert_eq!(store.baseline_id().await.unwrap().as_deref(), Some("a"));
        assert!(store.get("missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn interrupted_jobs_recovered_on_restart() {
        let file =
            std::env::temp_dir().join(format!("codex-drift-test-{}.db", uuid::Uuid::new_v4()));
        let url = format!(
            "sqlite://{}?mode=rwc",
            file.to_string_lossy().replace('\\', "/")
        );
        let store = Store::connect(&url).await.unwrap();
        store
            .save(&json!({"id":"pending", "created_at":"2026-01-01", "status":"running"}))
            .await
            .unwrap();
        store.pool.close().await;
        let recovered = Store::connect(&url).await.unwrap();
        assert_eq!(
            recovered.get("pending").await.unwrap().unwrap()["status"],
            "failed"
        );
        recovered.pool.close().await;
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires an isolated PostgreSQL database via DRIFT_TEST_DATABASE_URL"]
    async fn postgres_persistence_and_baseline() {
        let store = Store::connect(
            &std::env::var("DRIFT_TEST_DATABASE_URL").expect("test database URL required"),
        )
        .await
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut run = json!({"id":id, "created_at":"2026-01-01", "status":"queued"});
        store.save(&run).await.unwrap();
        run["status"] = "completed".into();
        store.save(&run).await.unwrap();
        assert_eq!(
            store.get(&id).await.unwrap().unwrap()["status"],
            "completed"
        );
        store.set_baseline(&id).await.unwrap();
        assert_eq!(
            store.baseline_id().await.unwrap().as_deref(),
            Some(id.as_str())
        );
    }
}

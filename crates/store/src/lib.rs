//! Persistence for the Whispera server.
//!
//! One [`Store`] wraps an `sqlx` pool over SQLite (default feature `sqlite`) or
//! Postgres (feature `postgres`), selected at runtime from the database URL.
//! Three tables: `accounts`, `devices` and `mailbox` (see `migrations/`).
//!
//! The mailbox holds opaque sealed blobs only; this crate never looks inside.
//! Every query uses `$N` placeholders, which both backends accept.

use sqlx::any::{AnyPoolOptions, AnyRow};
use sqlx::{AnyPool, Row};

/// Store errors. Messages never contain row contents.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("unsupported database url (expected sqlite: or postgres:)")]
    UnsupportedUrl,
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;

/// Which SQL backend a [`Store`] talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Sqlite,
    Postgres,
}

impl Backend {
    /// Pick the backend from a database URL.
    pub fn from_url(url: &str) -> Result<Self> {
        if url.starts_with("sqlite:") {
            Ok(Backend::Sqlite)
        } else if url.starts_with("postgres:") || url.starts_with("postgresql:") {
            Ok(Backend::Postgres)
        } else {
            Err(StoreError::UnsupportedUrl)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub issuer: String,
    pub subject: String,
    pub created_at: i64,
}

/// A device row. Public keys are X9.63 standard base64 strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub platform: String,
    pub link_pub: String,
    pub approve_pub: Option<String>,
    pub kem_pub: Option<String>,
    pub apns_token: Option<String>,
    pub apns_env: Option<String>,
    pub created_at: i64,
    pub revoked_at: Option<i64>,
}

impl Device {
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }
}

/// One stored relay message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailboxMessage {
    pub seq: i64,
    pub id: String,
    pub recipient_device: String,
    pub sender_device: String,
    pub ciphertext: Vec<u8>,
    pub created_at: i64,
    pub expires_at: i64,
}

/// A message to insert.
#[derive(Debug, Clone)]
pub struct NewMessage<'a> {
    pub recipient_device: &'a str,
    pub sender_device: &'a str,
    pub ciphertext: &'a [u8],
    pub created_at: i64,
    pub expires_at: i64,
}

/// Count and total ciphertext bytes of a device's live messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MailboxUsage {
    pub messages: i64,
    pub bytes: i64,
}

static SQLITE_MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/sqlite");
static POSTGRES_MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/postgres");

const DEVICE_COLS: &str = "id, account_id, name, platform, link_pub, approve_pub, kem_pub, \
                           apns_token, apns_env, created_at, revoked_at";

fn device_from_row(r: &AnyRow) -> Result<Device> {
    Ok(Device {
        id: r.try_get("id")?,
        account_id: r.try_get("account_id")?,
        name: r.try_get("name")?,
        platform: r.try_get("platform")?,
        link_pub: r.try_get("link_pub")?,
        approve_pub: r.try_get("approve_pub")?,
        kem_pub: r.try_get("kem_pub")?,
        apns_token: r.try_get("apns_token")?,
        apns_env: r.try_get("apns_env")?,
        created_at: r.try_get("created_at")?,
        revoked_at: r.try_get("revoked_at")?,
    })
}

fn message_from_row(r: &AnyRow) -> Result<MailboxMessage> {
    Ok(MailboxMessage {
        seq: r.try_get("seq")?,
        id: r.try_get("id")?,
        recipient_device: r.try_get("recipient_device")?,
        sender_device: r.try_get("sender_device")?,
        ciphertext: r.try_get("ciphertext")?,
        created_at: r.try_get("created_at")?,
        expires_at: r.try_get("expires_at")?,
    })
}

/// Database handle. Cheap to clone.
#[derive(Clone, Debug)]
pub struct Store {
    pool: AnyPool,
    backend: Backend,
}

impl Store {
    /// Connect and run migrations.
    ///
    /// SQLite URLs create the file if missing (`mode=rwc` is added unless a
    /// `mode` is given). `sqlite::memory:` is rejected by design: every pooled
    /// connection would see a different database.
    pub async fn connect(url: &str) -> Result<Self> {
        sqlx::any::install_default_drivers();
        let backend = Backend::from_url(url)?;
        let url = match backend {
            Backend::Sqlite if url.contains(":memory:") => return Err(StoreError::UnsupportedUrl),
            Backend::Sqlite if !url.contains("mode=") => {
                let sep = if url.contains('?') { '&' } else { '?' };
                format!("{url}{sep}mode=rwc")
            }
            _ => url.to_string(),
        };
        let max = match backend {
            Backend::Sqlite => 4,
            Backend::Postgres => 16,
        };
        let pool = AnyPoolOptions::new()
            .max_connections(max)
            .connect(&url)
            .await?;
        if backend == Backend::Sqlite {
            // WAL lets readers proceed while a writer holds the lock.
            sqlx::query("PRAGMA journal_mode = WAL")
                .execute(&pool)
                .await?;
        }
        match backend {
            Backend::Sqlite => SQLITE_MIGRATIONS.run(&pool).await?,
            Backend::Postgres => POSTGRES_MIGRATIONS.run(&pool).await?,
        }
        Ok(Self { pool, backend })
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    /// Cheap liveness check.
    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    // ---- accounts ----

    /// Find the account for `(issuer, subject)`, creating it on first sight.
    pub async fn upsert_account(&self, issuer: &str, subject: &str, now: i64) -> Result<Account> {
        let id = whispera_proto::sign::new_prefixed_id("acc");
        sqlx::query(
            "INSERT INTO accounts (id, issuer, subject, created_at) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (issuer, subject) DO NOTHING",
        )
        .bind(&id)
        .bind(issuer)
        .bind(subject)
        .bind(now)
        .execute(&self.pool)
        .await?;
        let r = sqlx::query(
            "SELECT id, issuer, subject, created_at FROM accounts WHERE issuer = $1 AND subject = $2",
        )
        .bind(issuer)
        .bind(subject)
        .fetch_one(&self.pool)
        .await?;
        Ok(Account {
            id: r.try_get("id")?,
            issuer: r.try_get("issuer")?,
            subject: r.try_get("subject")?,
            created_at: r.try_get("created_at")?,
        })
    }

    // ---- devices ----

    pub async fn insert_device(&self, d: &Device) -> Result<()> {
        sqlx::query(
            "INSERT INTO devices (id, account_id, name, platform, link_pub, approve_pub, kem_pub, \
             apns_token, apns_env, created_at, revoked_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(&d.id)
        .bind(&d.account_id)
        .bind(&d.name)
        .bind(&d.platform)
        .bind(&d.link_pub)
        .bind(&d.approve_pub)
        .bind(&d.kem_pub)
        .bind(&d.apns_token)
        .bind(&d.apns_env)
        .bind(d.created_at)
        .bind(d.revoked_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_device(&self, id: &str) -> Result<Option<Device>> {
        let q = format!("SELECT {DEVICE_COLS} FROM devices WHERE id = $1");
        sqlx::query(&q)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(device_from_row)
            .transpose()
    }

    /// All devices of an account (revoked ones included), oldest first.
    pub async fn list_devices(&self, account_id: &str) -> Result<Vec<Device>> {
        let q = format!(
            "SELECT {DEVICE_COLS} FROM devices WHERE account_id = $1 ORDER BY created_at, id"
        );
        sqlx::query(&q)
            .bind(account_id)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(device_from_row)
            .collect()
    }

    pub async fn count_active_devices(&self, account_id: &str) -> Result<i64> {
        let r = sqlx::query(
            "SELECT COUNT(*) AS n FROM devices WHERE account_id = $1 AND revoked_at IS NULL",
        )
        .bind(account_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(r.try_get("n")?)
    }

    /// Revoke a device of `account_id`. Clears its push token and drops its
    /// pending mail. Returns false if no such active device exists.
    pub async fn revoke_device(&self, account_id: &str, device_id: &str, now: i64) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let n = sqlx::query(
            "UPDATE devices SET revoked_at = $1, apns_token = NULL, apns_env = NULL \
             WHERE id = $2 AND account_id = $3 AND revoked_at IS NULL",
        )
        .bind(now)
        .bind(device_id)
        .bind(account_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n > 0 {
            sqlx::query("DELETE FROM mailbox WHERE recipient_device = $1 OR sender_device = $1")
                .bind(device_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(n > 0)
    }

    /// Set (`Some((token, env))`) or clear (`None`) an active device's APNs
    /// registration. Returns false if the device is unknown or revoked.
    pub async fn set_apns(&self, device_id: &str, apns: Option<(&str, &str)>) -> Result<bool> {
        let (token, env) = match apns {
            Some((t, e)) => (Some(t), Some(e)),
            None => (None, None),
        };
        Ok(sqlx::query(
            "UPDATE devices SET apns_token = $1, apns_env = $2 \
             WHERE id = $3 AND revoked_at IS NULL",
        )
        .bind(token)
        .bind(env)
        .bind(device_id)
        .execute(&self.pool)
        .await?
        .rows_affected()
            > 0)
    }

    /// Forget a device's APNs token (after APNs says it is unregistered).
    /// Only clears it if it still equals `token`.
    pub async fn clear_apns_token(&self, device_id: &str, token: &str) -> Result<()> {
        sqlx::query(
            "UPDATE devices SET apns_token = NULL, apns_env = NULL WHERE id = $1 AND apns_token = $2",
        )
        .bind(device_id)
        .bind(token)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ---- mailbox ----

    /// Store a message; returns `(id, seq)`.
    pub async fn mailbox_insert(&self, m: &NewMessage<'_>) -> Result<(String, i64)> {
        let id = whispera_proto::sign::new_prefixed_id("msg");
        let r = sqlx::query(
            "INSERT INTO mailbox (id, recipient_device, sender_device, ciphertext, created_at, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING seq",
        )
        .bind(&id)
        .bind(m.recipient_device)
        .bind(m.sender_device)
        .bind(m.ciphertext)
        .bind(m.created_at)
        .bind(m.expires_at)
        .fetch_one(&self.pool)
        .await?;
        Ok((id, r.try_get("seq")?))
    }

    /// Live (unexpired) message count and bytes queued for a device.
    pub async fn mailbox_usage(&self, recipient: &str, now: i64) -> Result<MailboxUsage> {
        let r = sqlx::query(
            "SELECT COUNT(*) AS n, CAST(COALESCE(SUM(LENGTH(ciphertext)), 0) AS BIGINT) AS b FROM mailbox \
             WHERE recipient_device = $1 AND expires_at > $2",
        )
        .bind(recipient)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(MailboxUsage {
            messages: r.try_get("n")?,
            bytes: r.try_get("b")?,
        })
    }

    /// Unexpired messages for `recipient` with `seq > after_seq`, oldest first.
    pub async fn mailbox_fetch(
        &self,
        recipient: &str,
        after_seq: i64,
        now: i64,
        limit: i64,
    ) -> Result<Vec<MailboxMessage>> {
        sqlx::query(
            "SELECT seq, id, recipient_device, sender_device, ciphertext, created_at, expires_at \
             FROM mailbox WHERE recipient_device = $1 AND seq > $2 AND expires_at > $3 \
             ORDER BY seq LIMIT $4",
        )
        .bind(recipient)
        .bind(after_seq)
        .bind(now)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(message_from_row)
        .collect()
    }

    /// Delete `recipient`'s messages with `seq <= up_to_seq`. Returns how many.
    pub async fn mailbox_ack(&self, recipient: &str, up_to_seq: i64) -> Result<u64> {
        Ok(
            sqlx::query("DELETE FROM mailbox WHERE recipient_device = $1 AND seq <= $2")
                .bind(recipient)
                .bind(up_to_seq)
                .execute(&self.pool)
                .await?
                .rows_affected(),
        )
    }

    /// Delete expired messages. Returns how many.
    pub async fn mailbox_purge_expired(&self, now: i64) -> Result<u64> {
        Ok(sqlx::query("DELETE FROM mailbox WHERE expires_at <= $1")
            .bind(now)
            .execute(&self.pool)
            .await?
            .rows_affected())
    }
}

use whispera_store::{Device, NewMessage, Store, StoreError};

/// SQLite in a temp dir, plus a fresh Postgres database when
/// `WHISPERA_TEST_POSTGRES_URL` (an admin URL) is set and the `postgres` feature is on.
async fn stores() -> (tempfile::TempDir, Vec<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", dir.path().join("t.db").display());
    let mut v = vec![Store::connect(&url).await.unwrap()];
    if let Some(pg) = pg_store().await {
        v.push(pg);
    }
    (dir, v)
}

#[cfg(feature = "postgres")]
async fn pg_store() -> Option<Store> {
    use sqlx::Connection;
    let admin = std::env::var("WHISPERA_TEST_POSTGRES_URL").ok()?;
    let name = format!("wtest_{}", &whispera_proto::sign::new_device_id()[4..]);
    let mut c = sqlx::PgConnection::connect(&admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&mut c)
        .await
        .unwrap();
    let (base, _) = admin.rsplit_once('/').unwrap();
    Some(Store::connect(&format!("{base}/{name}")).await.unwrap())
}

#[cfg(not(feature = "postgres"))]
async fn pg_store() -> Option<Store> {
    None
}

fn device(id: &str, account: &str) -> Device {
    Device {
        id: id.into(),
        account_id: account.into(),
        name: "n".into(),
        platform: "ios".into(),
        link_pub: "BA==".into(),
        approve_pub: None,
        kem_pub: Some("kem".into()),
        apns_token: Some("abcd".into()),
        apns_env: Some("sandbox".into()),
        created_at: 10,
        revoked_at: None,
    }
}

#[tokio::test]
async fn rejects_memory_and_unknown_urls() {
    assert!(matches!(
        Store::connect("sqlite::memory:").await,
        Err(StoreError::UnsupportedUrl)
    ));
    assert!(matches!(
        Store::connect("mysql://x").await,
        Err(StoreError::UnsupportedUrl)
    ));
}

#[tokio::test]
async fn accounts_upsert_is_stable() {
    let (_d, all) = stores().await;
    for s in all {
        accounts_upsert_is_stable_on(s).await;
    }
}

async fn accounts_upsert_is_stable_on(s: Store) {
    let a = s.upsert_account("iss", "sub", 1).await.unwrap();
    let b = s.upsert_account("iss", "sub", 2).await.unwrap();
    assert_eq!(a, b);
    assert!(a.id.starts_with("acc_"));
    let c = s.upsert_account("iss", "other", 3).await.unwrap();
    assert_ne!(a.id, c.id);
}

#[tokio::test]
async fn devices_and_revoke() {
    let (_d, all) = stores().await;
    for s in all {
        devices_and_revoke_on(s).await;
    }
}

async fn devices_and_revoke_on(s: Store) {
    let acc = s.upsert_account("iss", "sub", 1).await.unwrap();
    let other = s.upsert_account("iss", "x", 1).await.unwrap();
    s.insert_device(&device("dev_a", &acc.id)).await.unwrap();
    s.insert_device(&device("dev_b", &acc.id)).await.unwrap();
    assert_eq!(s.list_devices(&acc.id).await.unwrap().len(), 2);
    assert_eq!(s.count_active_devices(&acc.id).await.unwrap(), 2);
    let got = s.get_device("dev_a").await.unwrap().unwrap();
    assert_eq!(got, device("dev_a", &acc.id));
    // wrong account can't revoke
    assert!(!s.revoke_device(&other.id, "dev_a", 5).await.unwrap());
    s.mailbox_insert(&NewMessage {
        recipient_device: "dev_a",
        sender_device: "dev_b",
        ciphertext: b"x",
        created_at: 1,
        expires_at: 100,
    })
    .await
    .unwrap();
    assert!(s.revoke_device(&acc.id, "dev_a", 5).await.unwrap());
    assert!(!s.revoke_device(&acc.id, "dev_a", 6).await.unwrap());
    let a = s.get_device("dev_a").await.unwrap().unwrap();
    assert_eq!(a.revoked_at, Some(5));
    assert_eq!(a.apns_token, None);
    assert_eq!(s.count_active_devices(&acc.id).await.unwrap(), 1);
    assert!(s.mailbox_fetch("dev_a", 0, 0, 10).await.unwrap().is_empty());
    s.clear_apns_token("dev_b", "nope").await.unwrap();
    assert!(s
        .get_device("dev_b")
        .await
        .unwrap()
        .unwrap()
        .apns_token
        .is_some());
    s.clear_apns_token("dev_b", "abcd").await.unwrap();
    assert!(s
        .get_device("dev_b")
        .await
        .unwrap()
        .unwrap()
        .apns_token
        .is_none());
    // set_apns: set, clear, refused for revoked/unknown devices.
    assert!(s
        .set_apns("dev_b", Some(("ef01", "production")))
        .await
        .unwrap());
    let b = s.get_device("dev_b").await.unwrap().unwrap();
    assert_eq!(b.apns_token.as_deref(), Some("ef01"));
    assert_eq!(b.apns_env.as_deref(), Some("production"));
    assert!(s.set_apns("dev_b", None).await.unwrap());
    let b = s.get_device("dev_b").await.unwrap().unwrap();
    assert_eq!((b.apns_token, b.apns_env), (None, None));
    assert!(!s
        .set_apns("dev_a", Some(("ef01", "sandbox")))
        .await
        .unwrap());
    assert!(!s.set_apns("dev_zz", None).await.unwrap());
    assert_eq!(
        s.get_device("dev_a").await.unwrap().unwrap().apns_token,
        None
    );
}

#[tokio::test]
async fn mailbox_seq_ack_and_expiry() {
    let (_d, all) = stores().await;
    for s in all {
        mailbox_seq_ack_and_expiry_on(s).await;
    }
}

async fn mailbox_seq_ack_and_expiry_on(s: Store) {
    let acc = s.upsert_account("iss", "sub", 1).await.unwrap();
    s.insert_device(&device("dev_a", &acc.id)).await.unwrap();
    s.insert_device(&device("dev_b", &acc.id)).await.unwrap();
    let mut seqs = vec![];
    for (i, exp) in [100, 100, 20].into_iter().enumerate() {
        let (id, seq) = s
            .mailbox_insert(&NewMessage {
                recipient_device: "dev_b",
                sender_device: "dev_a",
                ciphertext: &[i as u8; 3],
                created_at: 10,
                expires_at: exp,
            })
            .await
            .unwrap();
        assert!(id.starts_with("msg_"));
        seqs.push(seq);
    }
    assert!(seqs.windows(2).all(|w| w[0] < w[1]));
    let u = s.mailbox_usage("dev_b", 50).await.unwrap();
    assert_eq!((u.messages, u.bytes), (2, 6));
    let m = s.mailbox_fetch("dev_b", 0, 50, 10).await.unwrap();
    assert_eq!(m.len(), 2);
    assert_eq!(m[1].ciphertext, vec![1u8; 3]);
    assert_eq!(s.mailbox_ack("dev_b", seqs[0]).await.unwrap(), 1);
    assert_eq!(s.mailbox_fetch("dev_b", 0, 50, 10).await.unwrap().len(), 1);
    assert_eq!(s.mailbox_purge_expired(50).await.unwrap(), 1);
    assert_eq!(s.mailbox_ack("dev_b", i64::MAX).await.unwrap(), 1);
    // seq never reused after everything was deleted
    let (_, next) = s
        .mailbox_insert(&NewMessage {
            recipient_device: "dev_b",
            sender_device: "dev_a",
            ciphertext: b"z",
            created_at: 10,
            expires_at: 100,
        })
        .await
        .unwrap();
    assert!(next > seqs[2]);
}

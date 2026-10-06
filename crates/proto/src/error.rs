//! Error codes and the OpenAI-compatible error envelope (PROTOCOL §13).

use serde::{Deserialize, Serialize};

macro_rules! error_codes {
    ($($variant:ident => ($s:literal, $status:literal)),+ $(,)?) => {
        /// Every §13 error code plus backend-specific ones.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum ErrorCode {
            $($variant,)+
        }

        impl ErrorCode {
            /// All codes, in declaration order.
            pub const ALL: &'static [ErrorCode] = &[$(ErrorCode::$variant,)+];

            /// Wire string (`auth_clock_skew`, …).
            pub fn as_str(self) -> &'static str {
                match self { $(ErrorCode::$variant => $s,)+ }
            }

            /// HTTP status for this code.
            pub fn http_status(self) -> u16 {
                match self { $(ErrorCode::$variant => $status,)+ }
            }
        }

        impl std::str::FromStr for ErrorCode {
            type Err = ();
            fn from_str(s: &str) -> Result<Self, ()> {
                match s { $($s => Ok(ErrorCode::$variant),)+ _ => Err(()) }
            }
        }
    };
}

error_codes! {
    BadRequest => ("bad_request", 400),
    AuthMissing => ("auth_missing", 401),
    AuthUnknownDevice => ("auth_unknown_device", 401),
    AuthRevoked => ("auth_revoked", 401),
    AuthClockSkew => ("auth_clock_skew", 401),
    AuthBadSignature => ("auth_bad_signature", 401),
    AuthReplay => ("auth_replay", 401),
    PairCodeInvalid => ("pair_code_invalid", 403),
    NotFound => ("not_found", 404),
    AgentBlocked => ("agent_blocked", 409),
    ApprovalNotPending => ("approval_not_pending", 409),
    PairCodeExpired => ("pair_code_expired", 410),
    ApprovalExpired => ("approval_expired", 410),
    LengthRequired => ("length_required", 411),
    PayloadTooLarge => ("payload_too_large", 413),
    BadSignature => ("bad_signature", 422),
    PairLocked => ("pair_locked", 429),
    RateLimited => ("rate_limited", 429),
    Internal => ("internal", 500),
    HerdrError => ("herdr_error", 502),
    UpstreamError => ("upstream_error", 502),
    HerdrUnavailable => ("herdr_unavailable", 503),
    BrokerUnavailable => ("broker_unavailable", 503),
    UpstreamUnconfigured => ("upstream_unconfigured", 503),
    HerdrTimeout => ("herdr_timeout", 504),
    BrokerTimeout => ("broker_timeout", 504),
    UpstreamTimeout => ("upstream_timeout", 504),
    // backend-specific
    AuthAccountMissing => ("auth_account_missing", 401),
    AuthAccountInvalid => ("auth_account_invalid", 401),
    AuthUnavailable => ("auth_unavailable", 503),
    Forbidden => ("forbidden", 403),
    MailboxFull => ("mailbox_full", 429),
}

impl ErrorCode {
    /// §13 `type`, mapped from the HTTP status.
    pub fn error_type(self) -> &'static str {
        error_type_for_status(self.http_status())
    }
}

/// §13 mapping of HTTP status to error `type`.
pub fn error_type_for_status(status: u16) -> &'static str {
    match status {
        401 | 403 | 429 => "auth_error",
        400 | 411 | 413 | 422 => "invalid_request_error",
        404 => "not_found_error",
        409 | 410 => "conflict_error",
        502..=504 => "upstream_error",
        _ => "server_error",
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::error::Error for ErrorCode {}

/// `{"error": {...}}`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
    #[serde(rename = "type")]
    pub error_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_time: Option<i64>,
    /// Extra fields (`herdr_code`, `status`, …), flattened into the error object.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ErrorEnvelope {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            error: ErrorBody {
                code,
                message: message.into(),
                error_type: code.error_type().to_owned(),
                server_time: None,
                extra: serde_json::Map::new(),
            },
        }
    }

    pub fn with_server_time(mut self, t: i64) -> Self {
        self.error.server_time = Some(t);
        self
    }

    pub fn with_extra(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.error.extra.insert(key.into(), value);
        self
    }

    pub fn http_status(&self) -> u16 {
        self.error.code.http_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mapping() {
        assert_eq!(ErrorCode::ALL.len(), 32);
        for &c in ErrorCode::ALL {
            assert_eq!(c.as_str().parse::<ErrorCode>(), Ok(c));
            assert_eq!(serde_json::to_value(c).unwrap(), json!(c.as_str()));
        }
        assert_eq!(ErrorCode::AuthClockSkew.http_status(), 401);
        assert_eq!(ErrorCode::AuthClockSkew.error_type(), "auth_error");
        assert_eq!(ErrorCode::PairCodeInvalid.error_type(), "auth_error");
        assert_eq!(ErrorCode::MailboxFull.error_type(), "auth_error");
        assert_eq!(
            ErrorCode::LengthRequired.error_type(),
            "invalid_request_error"
        );
        assert_eq!(
            ErrorCode::BadSignature.error_type(),
            "invalid_request_error"
        );
        assert_eq!(ErrorCode::NotFound.error_type(), "not_found_error");
        assert_eq!(ErrorCode::ApprovalExpired.error_type(), "conflict_error");
        assert_eq!(ErrorCode::UpstreamTimeout.error_type(), "upstream_error");
        assert_eq!(ErrorCode::Internal.error_type(), "server_error");
        assert_eq!(ErrorCode::Forbidden.http_status(), 403);
    }

    #[test]
    fn envelope_shape() {
        let e = ErrorEnvelope::new(ErrorCode::AuthClockSkew, "timestamp 75 s off server time")
            .with_server_time(1_791_158_400);
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({"error":{"code":"auth_clock_skew","message":"timestamp 75 s off server time","type":"auth_error","server_time":1791158400}})
        );
        let e2 = ErrorEnvelope::new(ErrorCode::NotFound, "no").with_extra("status", json!(7));
        let v = serde_json::to_value(&e2).unwrap();
        assert_eq!(
            v,
            json!({"error":{"code":"not_found","message":"no","type":"not_found_error","status":7}})
        );
        let back: ErrorEnvelope = serde_json::from_value(v).unwrap();
        assert_eq!(back, e2);
    }
}

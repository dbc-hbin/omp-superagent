use anyhow::{Result, anyhow, bail, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::value::RawValue;
use unicase::UniCase;
use zeroize::Zeroizing;

use super::Login;

const MAX_TOKEN_BYTES: usize = 32_768;
const INVALID_LOGIN: &str = "Invalid Codex managed login";

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Account {
    #[serde(deserialize_with = "object")]
    account: ManagedAccount,
    #[serde(rename = "requiresOpenaiAuth", deserialize_with = "required_true")]
    _requires_openai_auth: (),
    #[serde(default, deserialize_with = "nullable_object")]
    workspace_routing: Option<WorkspaceRouting>,
    user_id: Option<String>,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagedAccount {
    #[serde(rename = "type", deserialize_with = "managed_account")]
    _kind: (),
    plan_type: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    email: Option<String>,
    workspace_name: Option<String>,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRouting {
    backend_origin: String,
    account_routing_override: Option<String>,
    chatgpt_account_id: String,
}

#[derive(Deserialize)]
pub(super) struct AuthStatus {
    #[serde(rename = "authMethod", deserialize_with = "managed_account")]
    _method: (),
    #[serde(rename = "authToken", deserialize_with = "secret")]
    token: Zeroizing<String>,
    #[serde(rename = "requiresOpenaiAuth", deserialize_with = "required_true")]
    _requires_openai_auth: (),
}

#[derive(Deserialize)]
struct Claims {
    exp: u64,
    #[serde(rename = "https://api.openai.com/auth", deserialize_with = "object")]
    auth: AccountClaim,
    #[serde(
        rename = "https://api.openai.com/profile",
        default,
        deserialize_with = "nullable_object"
    )]
    profile: Option<ProfileClaim>,
}

#[derive(Deserialize)]
struct AccountClaim {
    #[serde(deserialize_with = "secret")]
    chatgpt_account_id: Zeroizing<String>,
    chatgpt_user_id: Option<String>,
}

#[derive(Deserialize)]
struct ProfileClaim {
    email: Option<String>,
}

impl Account {
    pub(super) fn check(&self) -> Result<()> {
        ensure!(
            matches!(
                self.account.plan_type.as_str(),
                "go" | "plus"
                    | "pro"
                    | "prolite"
                    | "promax"
                    | "team"
                    | "business"
                    | "enterprise"
                    | "edu"
                    | "edu_plus"
                    | "edu_pro"
                    | "ent26"
                    | "self_serve_business_prolite"
                    | "self_serve_business_usage_based"
                    | "enterprise_cbp_automation"
                    | "enterprise_cbp_usage_based"
                    | "sci"
                    | "sci_plus"
            ),
            "A ChatGPT subscription is required"
        );
        if let Some(route) = &self.workspace_routing {
            ensure!(
                matches!(
                    route.account_routing_override.as_deref(),
                    None | Some("NO_CONSTRAINT")
                ),
                "The Codex workspace requires account routing"
            );
            ensure!(
                route
                    .backend_origin
                    .split_once("://")
                    .is_some_and(|(scheme, authority)| {
                        scheme.eq_ignore_ascii_case("https")
                            && matches!(authority, "chatgpt.com" | "chatgpt.com/")
                    }),
                "The Codex workspace requires a different backend origin"
            );
        }
        Ok(())
    }

    pub(super) fn login(&self, status: AuthStatus, now: u64) -> Result<Login> {
        let token = status.token;
        ensure!(token.len() <= MAX_TOKEN_BYTES, INVALID_LOGIN);
        let mut parts = token.split('.');
        let (Some(header), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            bail!(INVALID_LOGIN);
        };
        ensure!(
            [header, payload, signature]
                .into_iter()
                .all(valid_identifier),
            INVALID_LOGIN
        );
        let payload = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| anyhow!(INVALID_LOGIN))?,
        );
        ensure!(payload.trim_ascii_start().starts_with(b"{"), INVALID_LOGIN);
        let claims: Claims =
            serde_json::from_slice(&payload).map_err(|_| anyhow!(INVALID_LOGIN))?;
        let identity = &claims.auth.chatgpt_account_id;
        let routed = self
            .workspace_routing
            .as_ref()
            .is_none_or(|route| route.chatgpt_account_id == identity.as_str());
        let same_user = self
            .user_id
            .as_deref()
            .zip(claims.auth.chatgpt_user_id.as_deref())
            .is_none_or(|(active, claim)| active.is_empty() || claim.is_empty() || active == claim);
        let same_email = self
            .account
            .email
            .as_deref()
            .zip(claims.profile.as_ref().and_then(|p| p.email.as_deref()))
            .is_none_or(|(active, claim)| {
                active.is_empty() || claim.is_empty() || UniCase::new(active) == UniCase::new(claim)
            });
        ensure!(
            claims.exp > now
                && identity.len() <= 128
                && valid_identifier(identity)
                && routed
                && same_user
                && same_email,
            "The Codex managed login is expired or does not match the active account"
        );
        // The provider, not this local read-back, verifies the JWT's signature and voice entitlement.
        Ok(Login {
            token,
            account_id: claims.auth.chatgpt_account_id,
        })
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn required_true<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<(), D::Error> {
    if bool::deserialize(deserializer)? {
        return Ok(());
    }
    Err(serde::de::Error::custom("expected true"))
}

fn secret<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(Zeroizing::new)
}

fn managed_account<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<(), D::Error> {
    if String::deserialize(deserializer)? == "chatgpt" {
        return Ok(());
    }
    Err(serde::de::Error::custom("expected managed ChatGPT account"))
}

// serde-derived structs otherwise accept positional arrays in addition to named JSON objects.
fn decode_object<T: DeserializeOwned, E: serde::de::Error>(
    raw: &RawValue,
) -> std::result::Result<T, E> {
    if !raw.get().starts_with('{') {
        return Err(E::custom("expected a JSON object"));
    }
    serde_json::from_str(raw.get()).map_err(|_| E::custom("invalid JSON object"))
}

fn object<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    deserializer: D,
) -> std::result::Result<T, D::Error> {
    decode_object(<&RawValue>::deserialize(deserializer)?)
}

fn nullable_object<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::<&RawValue>::deserialize(deserializer)?
        .map(decode_object)
        .transpose()
}

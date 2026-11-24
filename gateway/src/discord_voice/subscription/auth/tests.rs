use super::{Login, broker_command, run_broker};
use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs::{self, Permissions},
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use tokio::process::Command;

// Assert the broker's independent security and RPC contracts, not a copy of
// the production request generator. No fixture executes an installed Codex.
const REQUESTS: [&str; 5] = [
    r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"omp-superagent-voice","version":"1"}}}"#,
    r#"{"method":"initialized"}"#,
    r#"{"id":2,"method":"account/read","params":{"refreshToken":false}}"#,
    r#"{"id":3,"method":"getAuthStatus","params":{"includeToken":true,"refreshToken":false}}"#,
    r#"{"id":4,"method":"account/read","params":{"refreshToken":false}}"#,
];
const EOF: &str = r#"
if IFS= read -r extra; then
  printf '%s\n' "$extra" >> "$HOME/trace"
  exit 43
fi
printf 'closed\n' > "$HOME/closed"
"#;

pub(super) struct Fixture {
    home: TempDir,
    bin: PathBuf,
}

impl Fixture {
    pub(super) fn new() -> Self {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let bin = home.path().join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let poison = home.path().join("codex");
        fs::write(&poison, "#!/bin/sh\nexit 92\n").unwrap();
        fs::set_permissions(poison, Permissions::from_mode(0o700)).unwrap();
        Self { home, bin }
    }

    pub(super) fn home(&self) -> &Path {
        self.home.path()
    }

    fn env(&self, key: &str) -> Option<OsString> {
        match key {
            "HOME" | "PATH" => Some(self.home().as_os_str().to_owned()),
            "CODEX_HOME" => Some(self.home().join("managed").into_os_string()),
            "TMPDIR" => Some(self.home().join("fake-temp").into_os_string()),
            "OPENAI_API_KEY" | "HTTPS_PROXY" | "RUST_LOG" => Some("fixture-untrusted".into()),
            _ => None,
        }
    }

    pub(super) fn command(&self, responses: &[String], tail: &str) -> Command {
        let mut script = String::from(
            r#"#!/bin/sh
[ "$#" -eq 5 ] && [ "$1" = app-server ] && [ "$2" = --listen ] &&
[ "$3" = stdio:// ] && [ "$4" = -c ] && [ "$5" = analytics.enabled=false ] || exit 40
[ "$PATH" = "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/bin" ] &&
[ "$CODEX_HOME" = "$HOME/managed" ] && [ "$TMPDIR" = "$HOME/fake-temp" ] &&
[ "$RUST_LOG" = off ] && [ -z "${OPENAI_API_KEY+x}${HTTPS_PROXY+x}" ] || exit 41
[ "$PWD" != "$HOME" ] && [ -z "$(/bin/ls -A)" ] || exit 42
printf '%s\n' "$PWD" > "$HOME/cwd"
: > "$HOME/trace"
"#,
        );
        for reply in responses {
            assert!(!reply.contains('\''));
            script.push_str(
                "IFS= read -r request || exit 44\n\
                 printf '%s\\n' \"$request\" >> \"$HOME/trace\"\n",
            );
            if !reply.is_empty() {
                script.push_str(&format!("printf '%s\\n' '{reply}'\n"));
            }
        }
        script.push_str(tail);
        let executable = self.bin.join("codex");
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, Permissions::from_mode(0o700)).unwrap();
        let command = broker_command(|key| self.env(key)).unwrap();
        assert_eq!(command.as_std().get_program(), executable.as_os_str());
        command
    }

    fn assert_requests(&self, count: usize) {
        let trace = fs::read_to_string(self.home().join("trace")).unwrap();
        let decode = |line: &str| serde_json::from_str::<Value>(line).unwrap();
        let actual: Vec<_> = trace.lines().map(decode).collect();
        let expected: Vec<_> = REQUESTS[..count].iter().map(|line| decode(line)).collect();
        assert_eq!(actual, expected);
    }
}

fn active_account() -> Value {
    json!({
        "account": {
            "type":"chatgpt", "planType":"plus", "email":"Straße@example.invalid",
            "workspaceName":"fixture-workspace"
        },
        "requiresOpenaiAuth": true,
        "workspaceRouting": {
            "backendOrigin":"https://chatgpt.com",
            "accountRoutingOverride":"NO_CONSTRAINT",
            "chatgptAccountId":"fixture-account"
        },
        "userId":"fixture-user"
    })
}

fn claims() -> Value {
    json!({
        "exp":4_102_444_800_u64,
        "https://api.openai.com/auth":{
            "chatgpt_account_id":"fixture-account",
            "chatgpt_user_id":"fixture-user"
        },
        "https://api.openai.com/profile":{"email":"STRASSE@EXAMPLE.INVALID"}
    })
}

fn auth_status(claims: &Value) -> Value {
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    json!({"requiresOpenaiAuth":true,"authMethod":"chatgpt","authToken":format!("a.{payload}.b")})
}

fn exchange(active: &Value, status: &Value, confirmed: &Value) -> [String; 5] {
    [
        "{\"method\":\"account/updated\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}".to_owned(),
        String::new(),
        json!({"id":2,"result":active}).to_string(),
        json!({"id":3,"result":status}).to_string(),
        json!({"id":4,"result":confirmed}).to_string(),
    ]
}

fn assert_rejected(result: Result<Login>, reason: &str) {
    let error = result
        .err()
        .expect("unsafe fake managed login was accepted");
    assert!(error.to_string().contains(reason), "{error:#}");
    assert!(!format!("{error:?}").contains("private-marker"));
}

#[tokio::test]
async fn subscription_uses_the_trusted_stdio_broker_and_confirms_the_active_account() {
    let fixture = Fixture::new();
    let mut account = active_account();
    account["workspaceRouting"]["backendOrigin"] = json!("HTTPS://chatgpt.com/");
    let status = auth_status(&claims());
    let command = fixture.command(&exchange(&account, &status, &account), EOF);
    let login = run_broker(command).await.unwrap();
    assert_eq!(login.account_id(), "fixture-account");
    assert_eq!(Some(login.token()), status["authToken"].as_str());
    fixture.assert_requests(5);
    assert_eq!(
        fs::read_to_string(fixture.home().join("closed")).unwrap(),
        "closed\n"
    );
    let cwd = fs::read_to_string(fixture.home().join("cwd")).unwrap();
    assert!(!Path::new(cwd.trim_end()).exists());
}

#[tokio::test]
async fn rejects_ineligible_accounts_before_asking_for_a_token() {
    for (field, invalid, reason) in [
        ("/account/type", json!("apiKey"), "Unexpected"),
        (
            "/account/planType",
            json!("free"),
            "subscription is required",
        ),
        ("/requiresOpenaiAuth", json!(false), "Unexpected"),
        ("/workspaceRouting", json!([]), "Unexpected"),
        (
            "/workspaceRouting/accountRoutingOverride",
            json!("us"),
            "account routing",
        ),
        (
            "/workspaceRouting/backendOrigin",
            json!("https://chatgpt.com@other.invalid"),
            "backend origin",
        ),
        (
            "/workspaceRouting/backendOrigin",
            json!("https://chatgpt.com/?foo=bar"),
            "backend origin",
        ),
    ] {
        let fixture = Fixture::new();
        let mut account = active_account();
        *account.pointer_mut(field).unwrap() = invalid;
        let responses = exchange(&account, &auth_status(&claims()), &account);
        assert_rejected(
            run_broker(fixture.command(&responses[..3], EOF)).await,
            reason,
        );
        fixture.assert_requests(3);
    }
}

#[tokio::test]
async fn rejects_a_token_from_a_non_managed_auth_session() {
    let fixture = Fixture::new();
    let account = active_account();
    let status =
        json!({"requiresOpenaiAuth":true,"authMethod":"apiKey","authToken":"private-marker"});
    let responses = exchange(&account, &status, &account);
    assert_rejected(
        run_broker(fixture.command(&responses[..4], EOF)).await,
        "Unexpected",
    );
    fixture.assert_requests(4);
}

#[tokio::test]
async fn rejects_a_changed_account_after_the_broker_returns_its_token() {
    let fixture = Fixture::new();
    let account = active_account();
    let mut confirmed = account.clone();
    confirmed["account"]["workspaceName"] = json!("a different workspace");
    let command = fixture.command(
        &exchange(&account, &auth_status(&claims()), &confirmed),
        EOF,
    );
    assert_rejected(run_broker(command).await, "changed during voice startup");
    fixture.assert_requests(5);
}

#[tokio::test]
async fn rejects_expired_or_mismatched_claims_and_invalid_token_shapes() {
    let account = active_account();
    let mut statuses = Vec::new();
    for (object, field, value) in [
        (None, "exp", json!(1)),
        (
            Some("https://api.openai.com/auth"),
            "chatgpt_account_id",
            json!("other-account"),
        ),
        (
            Some("https://api.openai.com/auth"),
            "chatgpt_account_id",
            json!("bad/id"),
        ),
        (
            Some("https://api.openai.com/auth"),
            "chatgpt_user_id",
            json!("other-user"),
        ),
        (
            Some("https://api.openai.com/profile"),
            "email",
            json!("other@example.invalid"),
        ),
    ] {
        let mut claim = claims();
        match object {
            Some(key) => claim[key][field] = value,
            None => claim[field] = value,
        }
        statuses.push((auth_status(&claim), "expired or does not match"));
    }
    for invalid in [
        "private-marker".to_owned(),
        format!("a.{}.b", "A".repeat(32_768)),
    ] {
        let mut status = auth_status(&claims());
        status["authToken"] = json!(invalid);
        statuses.push((status, "Invalid Codex managed login"));
    }
    for (status, reason) in statuses {
        let fixture = Fixture::new();
        let command = fixture.command(&exchange(&account, &status, &account), EOF);
        assert_rejected(run_broker(command).await, reason);
        fixture.assert_requests(5);
    }
}

#[tokio::test]
async fn rejects_unsolicited_requests_wrong_responses_and_unbounded_frames() {
    let good = r#"{"id":1,"result":{}}"#;
    for invalid in [
        r#"{"id":"1","result":{}}"#.to_owned(),
        r#"{"id":2,"result":{}}"#.to_owned(),
        r#"{"id":1,"id":1,"result":{}}"#.to_owned(),
        r#"{"jsonrpc":null,"id":1,"result":{}}"#.to_owned(),
        r#"{"id":1,"result":[]}"#.to_owned(),
        r#"{"id":1,"result":{},"error":{"message":"private-marker"}}"#.to_owned(),
        r#"{"id":null,"method":"account/updated"}"#.to_owned(),
        r#"{"id":7,"method":"request", "params":{}}"#.to_owned(),
        r#"{"method":"ignored","result":{"secret":"private-marker"}}"#.to_owned(),
        "{\"method\":\"account/updated\"}\n".repeat(64),
        format!(
            r#"{{"method":"ignored","params":{{"data":"{}"}}}}"#,
            "x".repeat(256 * 1024)
        ),
    ] {
        let fixture = Fixture::new();
        let response = format!("{invalid}\n{good}");
        let command = fixture.command(&[response], EOF);
        assert_rejected(run_broker(command).await, "Unexpected");
        fixture.assert_requests(1);
    }
}

#[test]
fn rejects_relative_managed_home_before_creating_the_broker() {
    let fixture = Fixture::new();
    // Populate the trusted fake so resolution never needs the system CLI.
    drop(fixture.command(&[], EOF));
    let result = broker_command(|key| {
        if key == "CODEX_HOME" {
            return Some("relative".into());
        }
        fixture.env(key)
    });
    assert!(result.unwrap_err().to_string().contains("must be absolute"));
}

#[tokio::test]
async fn retries_transient_executable_file_busy_when_starting_broker() {
    let fixture = Fixture::new();
    let account = active_account();
    let status = auth_status(&claims());
    let command = fixture.command(&exchange(&account, &status, &account), EOF);
    let writer = std::fs::OpenOptions::new()
        .append(true)
        .open(command.as_std().get_program())
        .unwrap();
    let release = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        drop(writer);
    });
    let login = run_broker(command).await.unwrap();
    release.await.unwrap();
    assert_eq!(login.account_id(), "fixture-account");
    fixture.assert_requests(5);
}

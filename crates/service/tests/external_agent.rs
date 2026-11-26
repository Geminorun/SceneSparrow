//! EWA-T01 fixtures are compiled into this test binary only, never selected by environment.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use scenesparrow_application::external_agent::*;
use scenesparrow_service::markdown_projects::{router, router_with_agent};
use serde_json::{Value, json};
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tower::ServiceExt;

const TOKEN: &str = "fixture-token";
const ORIGIN: &str = "https://scene.example";
#[derive(Default)]
struct Fixture {
    calls: AtomicUsize,
    closes: AtomicUsize,
    gate: (Mutex<bool>, Condvar),
    cancelled: AtomicBool,
}
impl Fixture {
    fn release(&self) {
        *self.gate.0.lock().unwrap() = true;
        self.gate.1.notify_all();
    }
}
impl WritingAgent for Fixture {
    fn check(&self, engine: &str, model: &str) -> Result<()> {
        if engine == "fixture" && model == "gpt-5.4" {
            Ok(())
        } else {
            Err("AGENT_MODEL_UNAVAILABLE")
        }
    }
    fn close_session(&self, _: &str) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
    fn run(
        &self,
        input: AgentInput,
        cancelled: Arc<AtomicBool>,
        emit: &mut dyn FnMut(AgentDelta) -> Result<()>,
    ) -> Result<AgentOutput> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(input.context.project_id.len(), 36);
        emit(AgentDelta::Text("Partial 中文".into()))?;
        emit(AgentDelta::Progress("Reading captured document".into()))?;
        if input.instruction == "wait" {
            let mut gate = self.gate.0.lock().unwrap();
            while !*gate {
                let (next, timeout) = self
                    .gate
                    .1
                    .wait_timeout(gate, std::time::Duration::from_secs(5))
                    .unwrap();
                gate = next;
                if timeout.timed_out() {
                    return Err("AGENT_FIXTURE_TIMEOUT");
                }
            }
            self.cancelled
                .store(cancelled.load(Ordering::Acquire), Ordering::Release);
            // A hostile/late adapter deliberately ignores the cancellation error.
            let _ = emit(AgentDelta::Text("Late partial".into()));
        }
        if input.instruction == "fail" {
            return Err("AGENT_FIXTURE_FAILED");
        }
        if input.instruction == "budget" {
            for _ in 0..MAX_EVENTS {
                let _ = emit(AgentDelta::Progress(String::new()));
            }
        }
        Ok(AgentOutput {
            reply: "Finished".into(),
            replacement: if input.instruction == "oversized" {
                Some("x".repeat(MAX_OUTPUT_BYTES + 1))
            } else if input.instruction == "question" {
                None
            } else {
                Some("新 paragraph".into())
            },
        })
    }
}
async fn raw(
    app: &Router,
    path: &str,
    body: Option<Value>,
    authorization: bool,
    origin: &str,
) -> axum::response::Response {
    let mut request = Request::builder()
        .uri(path)
        .method(if body.is_some() { "POST" } else { "GET" })
        .header("origin", origin);
    if authorization {
        request = request.header("authorization", format!("Bearer {TOKEN}"));
    }
    app.clone()
        .oneshot(
            request
                .header("content-type", "application/json")
                .body(Body::from(body.map_or(String::new(), |v| v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn call(app: &Router, path: &str, body: Option<Value>) -> (u16, Value) {
    let response = raw(app, path, body, true, ORIGIN).await;
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn setup() -> (tempfile::TempDir, Router, Arc<Fixture>, Value, String) {
    let root = tempfile::tempdir().unwrap();
    let fixture = Arc::new(Fixture::default());
    let app = router_with_agent(root.path(), TOKEN, ORIGIN, fixture.clone()).unwrap();
    let (status, project) = call(
        &app,
        "/v1/markdown-projects",
        Some(json!({"text":"\u{feff}# Heading\r\n\r\nTarget 中文\r\n\r\nTail\r\n"})),
    )
    .await;
    assert_eq!(status, 200);
    let path = format!(
        "/v1/markdown-projects/{}/agent/sessions",
        project["projectId"].as_str().unwrap()
    );
    let (status, session) = call(
        &app,
        &path,
        Some(json!({"requestId":"create-1","engineId":"fixture","modelId":"gpt-5.4"})),
    )
    .await;
    assert_eq!(status, 200, "{session}");
    let session_path = format!("{path}/{}", session["id"].as_str().unwrap());
    (root, app, fixture, project, session_path)
}
fn request(project: &Value, id: &str, instruction: &str) -> Value {
    let text = project["text"].as_str().unwrap();
    let start = text.find("Target 中文").unwrap();
    json!({"requestId":id,"instruction":instruction,"attachment":{"kind":"manuscript","revision":project["revision"],"sourceDigest":project["revision"],"selection":{"range":{"start":start,"end":start+"Target 中文".len()},"quote":"Target 中文"},"buffer":null}})
}
async fn settled(app: &Router, session: &str) -> Value {
    for _ in 0..200 {
        let (_, value) = call(app, session, None).await;
        let turn = value["turns"].as_array().unwrap().last().unwrap();
        if turn["status"] != "running" {
            return turn.clone();
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("fixture did not settle");
}
async fn started(fixture: &Fixture) {
    for _ in 0..200 {
        if fixture.calls.load(Ordering::Acquire) > 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("fixture did not start");
}
#[tokio::test]
async fn ewa_ac01_ac03_capture_events_exact_apply_duplicate_and_project_scope() {
    let (_root, app, fixture, project, session) = setup().await;
    let body = request(&project, "turn-1", "edit");
    let (status, turn) = call(&app, &format!("{session}/turns"), Some(body.clone())).await;
    assert_eq!(status, 200);
    let (_, duplicate) = call(&app, &format!("{session}/turns"), Some(body.clone())).await;
    assert_eq!(duplicate["id"], turn["id"]);
    let done = settled(&app, &session).await;
    assert_eq!(done["status"], "completed");
    assert_eq!(fixture.calls.load(Ordering::Acquire), 1);
    assert_eq!(done["proposal"]["context"], done["context"]);
    let turn_path = format!("{session}/turns/{}", turn["id"].as_str().unwrap());
    assert_eq!(
        raw(&app, &format!("{turn_path}/events"), None, false, ORIGIN)
            .await
            .status(),
        401
    );
    assert_eq!(
        raw(
            &app,
            &format!("{turn_path}/events"),
            None,
            true,
            "https://scene.example.evil"
        )
        .await
        .status(),
        403
    );
    let response = raw(&app, &format!("{turn_path}/events"), None, true, ORIGIN).await;
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap();
    let stream = String::from_utf8(bytes.to_vec()).unwrap();
    let data = stream
        .lines()
        .find_map(|l| l.strip_prefix("data: "))
        .unwrap();
    let events: Vec<Value> = serde_json::from_str(data).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|v| v["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["text", "progress", "proposal", "final"]
    );
    for (n, event) in events.iter().enumerate() {
        assert_eq!(event["sequence"], n + 1);
        assert_eq!(event["projectId"], project["projectId"]);
    }
    // Reading/saving the other document represents a tab switch; it cannot retarget this proposal.
    let project_path = format!(
        "/v1/markdown-projects/{}",
        project["projectId"].as_str().unwrap()
    );
    let (_, outline) = call(
        &app,
        &format!("{project_path}/documents/outline"),
        Some(json!({"revision":null,"text":"# Other tab"})),
    )
    .await;
    assert_eq!(outline["kind"], "outline");
    let action = json!({"proposalId":done["proposal"]["id"]});
    let (status, receipt) = call(&app, &format!("{turn_path}/apply"), Some(action.clone())).await;
    assert_eq!(status, 200, "{receipt}");
    let (_, current) = call(&app, &project_path, None).await;
    assert_eq!(
        current["text"],
        "\u{feff}# Heading\r\n\r\n新 paragraph\r\n\r\nTail\r\n"
    );
    assert_eq!(receipt["revision"], current["revision"]);
    let (_, changed) = call(
        &app,
        &project_path,
        Some(json!({"revision":current["revision"],"text":"Later manual edit",})),
    )
    .await;
    assert_eq!(changed["text"], "Later manual edit");
    assert_eq!(
        call(&app, &format!("{turn_path}/apply"), Some(action)).await,
        (200, receipt)
    );
    let (_, other) = call(
        &app,
        "/v1/markdown-projects",
        Some(json!({"text":"Other project"})),
    )
    .await;
    let wrong = session.replace(
        project["projectId"].as_str().unwrap(),
        other["projectId"].as_str().unwrap(),
    );
    assert_eq!(
        call(&app, &wrong, None).await.1["code"],
        "AGENT_SESSION_NOT_FOUND"
    );
    let mut changed_request = body;
    changed_request["instruction"] = json!("Changed request");
    assert_eq!(
        call(&app, &format!("{session}/turns"), Some(changed_request))
            .await
            .1["code"],
        "AGENT_REQUEST_CONFLICT"
    );
}
#[tokio::test]
async fn ewa_ac02_live_locks_stale_source_failed_save_and_repeat_failure() {
    let (_root, app, fixture, project, session) = setup().await;
    let mut unsaved = request(&project, "bad-save", "edit");
    unsaved["attachment"]["selection"]["quote"] = json!("Local unsaved text");
    assert_eq!(
        call(&app, &format!("{session}/turns"), Some(unsaved))
            .await
            .1["code"],
        "AGENT_SELECTION_INVALID"
    );
    assert_eq!(fixture.calls.load(Ordering::Acquire), 0);
    let body = request(&project, "turn-1", "edit");
    call(&app, &format!("{session}/turns"), Some(body.clone())).await;
    let done = settled(&app, &session).await;
    let doc = format!(
        "/v1/markdown-projects/{}/documents/manuscript",
        project["projectId"].as_str().unwrap()
    );
    let annotation = json!({"action":"lock","revision":project["revision"],"ranges":[body["attachment"]["selection"]["range"].clone()]});
    let (status, locks) = call(&app, &format!("{doc}/annotations"), Some(annotation)).await;
    assert_eq!(status, 200, "{locks}");
    assert_eq!(
        call(
            &app,
            &format!("{session}/turns"),
            Some(request(&project, "locked-question", "question"))
        )
        .await
        .0,
        200
    );
    let question = settled(&app, &session).await;
    assert_eq!(question["status"], "completed");
    assert_eq!(question["proposal"], Value::Null);
    let action = json!({"proposalId":done["proposal"]["id"]});
    let turn_path = format!("{session}/turns/{}", done["id"].as_str().unwrap());
    assert_eq!(
        call(&app, &format!("{turn_path}/apply"), Some(action.clone()))
            .await
            .1["code"],
        "MARKDOWN_LOCKED"
    );
    assert_eq!(call(&app, &doc, None).await.1["text"], project["text"]);
    let lock = locks["locks"][0]["id"].clone();
    assert_eq!(
        call(
            &app,
            &format!("{doc}/annotations"),
            Some(json!({"action":"unlock","id":lock}))
        )
        .await
        .0,
        200
    );
    // Failed Apply is settled within the live session, even after the lock is removed.
    assert_eq!(
        call(&app, &format!("{turn_path}/apply"), Some(action))
            .await
            .1["code"],
        "MARKDOWN_LOCKED"
    );
    let (_, retained) = call(&app, &session, None).await;
    assert_eq!(retained["turns"][0]["proposal"], done["proposal"]);
    call(
        &app,
        &format!("{session}/turns"),
        Some(request(&project, "explicit-retry", "edit")),
    )
    .await;
    let retry = settled(&app, &session).await;
    assert_eq!(
        call(
            &app,
            &doc,
            Some(json!({"revision":project["revision"],"text":"User edited target"}))
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(
            &app,
            &format!("{session}/turns/{}/apply", retry["id"].as_str().unwrap()),
            Some(json!({"proposalId":retry["proposal"]["id"]}))
        )
        .await
        .1["code"],
        "MARKDOWN_CONFLICT"
    );
    assert_eq!(
        call(
            &app,
            &format!("{session}/turns"),
            Some(request(&project, "stale-dispatch", "edit"))
        )
        .await
        .1["code"],
        "MARKDOWN_CONFLICT"
    );
}
#[tokio::test]
async fn ewa_ac03_cancel_late_duplicates_close_explicit_retry_and_partial_failure() {
    let (_root, app, fixture, project, session) = setup().await;
    let body = request(&project, "turn-1", "wait");
    let (_, turn) = call(&app, &format!("{session}/turns"), Some(body.clone())).await;
    started(&fixture).await;
    assert_eq!(
        call(
            &app,
            &format!("{session}/turns"),
            Some(request(&project, "busy", "edit"))
        )
        .await
        .1["code"],
        "AGENT_TURN_ACTIVE"
    );
    let turn_path = format!("{session}/turns/{}", turn["id"].as_str().unwrap());
    let (_, cancelled) = call(&app, &format!("{turn_path}/cancel"), Some(json!({}))).await;
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(
        call(&app, &format!("{turn_path}/cancel"), Some(json!({})))
            .await
            .1,
        cancelled
    );
    assert_eq!(
        call(&app, &format!("{session}/turns"), Some(body)).await.1,
        cancelled
    );
    assert_eq!(
        call(
            &app,
            &format!("{session}/turns"),
            Some(request(&project, "cleanup-retry", "edit"))
        )
        .await
        .1["code"],
        "AGENT_TURN_ACTIVE"
    );
    fixture.release();
    for _ in 0..100 {
        if fixture.cancelled.load(Ordering::Acquire) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(fixture.cancelled.load(Ordering::Acquire));
    assert_eq!(settled(&app, &session).await["proposal"], Value::Null);
    let stream = raw(&app, &format!("{turn_path}/events"), None, true, ORIGIN).await;
    let text = String::from_utf8(
        to_bytes(stream.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(!text.contains("Late partial"));
    assert!(!text.contains("\"type\":\"proposal\""));
    assert_eq!(text.matches("\"type\":\"final\"").count(), 1);
    for _ in 0..100 {
        let (status, value) = call(
            &app,
            &format!("{session}/turns"),
            Some(request(&project, "retry-1", "fail")),
        )
        .await;
        if status == 200 {
            break;
        }
        assert_eq!(value["code"], "AGENT_TURN_ACTIVE");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let failed = settled(&app, &session).await;
    assert_eq!(failed["errorCode"], "AGENT_FIXTURE_FAILED");
    assert_eq!(failed["proposal"], Value::Null);
    assert_eq!(fixture.calls.load(Ordering::Acquire), 2);
    assert_eq!(
        call(&app, &format!("{session}/close"), Some(json!({})))
            .await
            .0,
        200
    );
    assert_eq!(fixture.closes.load(Ordering::Acquire), 1);
    assert_eq!(
        call(&app, &session, None).await.1["code"],
        "AGENT_SESSION_CLOSED"
    );
}
#[tokio::test]
async fn ewa_budgets_and_shipped_adapter_unavailable() {
    let (_root, app, _fixture, project, session) = setup().await;
    for (id, instruction, expected) in [
        ("no-selection-edit", "edit", "failed"),
        ("no-selection-question", "question", "completed"),
    ] {
        let mut body = request(&project, id, instruction);
        body["attachment"]["selection"] = Value::Null;
        assert_eq!(
            call(&app, &format!("{session}/turns"), Some(body)).await.0,
            200
        );
        let turn = settled(&app, &session).await;
        assert_eq!(turn["status"], expected);
        assert_eq!(turn["proposal"], Value::Null);
    }
    for (id, instruction, expected) in [
        ("oversize", "oversized", "AGENT_OUTPUT_LIMIT"),
        ("events", "budget", "AGENT_OUTPUT_LIMIT"),
    ] {
        call(
            &app,
            &format!("{session}/turns"),
            Some(request(&project, id, instruction)),
        )
        .await;
        let turn = settled(&app, &session).await;
        assert_eq!(turn["errorCode"], expected);
        assert_eq!(turn["proposal"], Value::Null);
    }
    // Ordinary short follow-ups fit; turn history still has a clear hard bound.
    let mut hit_limit = false;
    for n in 0..40 {
        let (status, value) = call(
            &app,
            &format!("{session}/turns"),
            Some(request(&project, &format!("retry-{n}"), "fail")),
        )
        .await;
        if status != 200 {
            assert_eq!(value["code"], "AGENT_TURN_LIMIT");
            hit_limit = true;
            break;
        }
        settled(&app, &session).await;
    }
    assert!(hit_limit);
    let base = session.rsplit_once('/').unwrap().0;
    for n in 0..MAX_SESSIONS + 2 {
        let (status, created) = call(
            &app,
            base,
            Some(json!({"requestId":format!("next-{n}"),"engineId":"fixture","modelId":"gpt-5.4"})),
        )
        .await;
        assert_eq!(status, 200, "{created}");
        let close = format!("{base}/{}/close", created["id"].as_str().unwrap());
        assert_eq!(call(&app, &close, Some(json!({}))).await.0, 200);
    }
    let root = tempfile::tempdir().unwrap();
    let unavailable = router(root.path(), TOKEN, ORIGIN).unwrap();
    let (_, p) = call(
        &unavailable,
        "/v1/markdown-projects",
        Some(json!({"text":"Production"})),
    )
    .await;
    let path = format!(
        "/v1/markdown-projects/{}/agent/sessions",
        p["projectId"].as_str().unwrap()
    );
    assert_eq!(
        call(
            &unavailable,
            &path,
            Some(json!({"requestId":"real","engineId":"fixture","modelId":"gpt-5.4"}))
        )
        .await
        .1["code"],
        "AGENT_UNAVAILABLE"
    );
}

#[tokio::test]
async fn ewa_global_catalog_is_authenticated_and_never_generates() {
    let (_root, app, fixture, _, _) = setup().await;
    assert_eq!(
        raw(&app, "/v1/agent/catalog", None, false, ORIGIN)
            .await
            .status(),
        401
    );
    assert_eq!(
        raw(
            &app,
            "/v1/agent/catalog",
            None,
            true,
            "https://wrong.example"
        )
        .await
        .status(),
        403
    );
    let (status, catalog) = call(&app, "/v1/agent/catalog", None).await;
    assert_eq!(status, 200);
    assert_eq!(catalog[0]["status"], "not_configured");
    assert_eq!(fixture.calls.load(Ordering::Acquire), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn dsh_ac03_native_question_proposals_duplicate_and_guarded_apply() {
    use scenesparrow_application::ai::CredentialLease;
    use scenesparrow_infrastructure::deepseek_agent::{DeepSeekAgent, WritingAgents};
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixListener,
    };
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("fixture.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let native = std::thread::spawn(move || {
        for _ in 0..5 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap(),
                json!({"protocolVersion":1,"apiKey":"SYNTHETIC_DSH_SERVICE"})
            );
            writeln!(stream, "{}", json!({"protocolVersion":1,"ready":true,"engine":"deepseek","packageVersion":"0.2.2-rc.5","credentialPresent":true})).unwrap();
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let message: Value = serde_json::from_str(&line).unwrap();
                let id = &message["id"];
                let result = match message["method"].as_str().unwrap() {
                    "initialize" => {
                        json!({"protocolVersion":1,"agentInfo":{"name":"deepseek-harness-acp"}})
                    }
                    "session/new" => {
                        json!({"sessionId":"native","configOptions":[{"id":"model","type":"select","options":[{"value":"[\"deepseek-official\",\"deepseek-flash\"]","name":"DeepSeek Flash"}]}]})
                    }
                    "session/set_config_option" => {
                        assert_eq!(
                            message["params"]["value"],
                            "[\"deepseek-official\",\"deepseek-flash\"]"
                        );
                        json!({"configOptions":[{"id":"model","currentValue":message["params"]["value"]}]})
                    }
                    "session/prompt" => {
                        observed.fetch_add(1, Ordering::SeqCst);
                        let prompt = message["params"]["prompt"][0]["text"].as_str().unwrap();
                        let text = if prompt.contains("\"scope\":\"selection\"") {
                            json!({"reply":"An edit", "replacement":"新 paragraph"}).to_string()
                        } else {
                            "An answer".into()
                        };
                        writeln!(stream, "{}", json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})).unwrap();
                        json!({"stopReason":"end_turn"})
                    }
                    "session/cancel" => continue,
                    "session/close" => break,
                    method => panic!("Unexpected method {method}"),
                };
                writeln!(
                    stream,
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"result":result})
                )
                .unwrap();
            }
        }
    });
    let adapter = WritingAgents {
        codex: scenesparrow_infrastructure::codex_agent::CodexAgent::new(None),
        deepseek: DeepSeekAgent::new(
            Some(socket),
            Arc::new(|| Ok(CredentialLease::new(Some("SYNTHETIC_DSH_SERVICE".into())))),
        ),
    };
    let app = router_with_agent(root.path(), TOKEN, ORIGIN, Arc::new(adapter)).unwrap();
    let (_, catalog) = call(&app, "/v1/agent/catalog", None).await;
    assert_eq!(catalog[0]["id"], "codex");
    assert_eq!(catalog[1]["id"], "deepseek");
    assert_eq!(catalog[1]["available"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let (_, project) = call(
        &app,
        "/v1/markdown-projects",
        Some(json!({"text":"\u{feff}# Heading\r\n\r\nTarget 中文\r\n\r\nTail\r\n"})),
    )
    .await;
    let base = format!(
        "/v1/markdown-projects/{}/agent/sessions",
        project["projectId"].as_str().unwrap()
    );
    let (_, session) = call(
        &app,
        &base,
        Some(json!({"requestId":"native-create","engineId":"deepseek","modelId":"deepseek-flash"})),
    )
    .await;
    let session = format!("{base}/{}", session["id"].as_str().unwrap());
    let mut question = request(&project, "question", "Question");
    question["attachment"]["selection"] = Value::Null;
    assert_eq!(
        call(&app, &format!("{session}/turns"), Some(question))
            .await
            .0,
        200
    );
    assert_eq!(settled(&app, &session).await["proposal"], Value::Null);
    let mut proposals = vec![];
    for id in ["apply", "stale", "locked"] {
        let body = request(&project, id, "Edit");
        let (_, first) = call(&app, &format!("{session}/turns"), Some(body.clone())).await;
        let (_, duplicate) = call(&app, &format!("{session}/turns"), Some(body)).await;
        assert_eq!(first["id"], duplicate["id"]);
        let done = settled(&app, &session).await;
        assert_eq!(done["status"], "completed", "{done}");
        proposals.push(done);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    let doc = format!(
        "/v1/markdown-projects/{}/documents/manuscript",
        project["projectId"].as_str().unwrap()
    );
    let (_, locks) = call(&app, &format!("{doc}/annotations"), Some(json!({"action":"lock","revision":project["revision"],"ranges":[request(&project, "range", "x")["attachment"]["selection"]["range"]]}))).await;
    let apply = |turn: &Value| format!("{session}/turns/{}/apply", turn["id"].as_str().unwrap());
    assert_eq!(
        call(
            &app,
            &apply(&proposals[2]),
            Some(json!({"proposalId":proposals[2]["proposal"]["id"]}))
        )
        .await
        .1["code"],
        "MARKDOWN_LOCKED"
    );
    assert_eq!(
        call(&app, &session, None).await.1["turns"][3]["proposal"],
        proposals[2]["proposal"]
    );
    assert_eq!(
        call(
            &app,
            &format!("{doc}/annotations"),
            Some(json!({"action":"unlock","id":locks["locks"][0]["id"]}))
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(
            &app,
            &apply(&proposals[0]),
            Some(json!({"proposalId":proposals[0]["proposal"]["id"]}))
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(&app, &doc, None).await.1["text"],
        "\u{feff}# Heading\r\n\r\n新 paragraph\r\n\r\nTail\r\n"
    );
    assert_eq!(
        call(
            &app,
            &apply(&proposals[1]),
            Some(json!({"proposalId":proposals[1]["proposal"]["id"]}))
        )
        .await
        .1["code"],
        "MARKDOWN_CONFLICT"
    );
    assert_eq!(
        call(&app, &session, None).await.1["turns"][2]["proposal"],
        proposals[1]["proposal"]
    );
    native.join().unwrap();
}

//! Read-only project references and a supervised, bounded public-search capability.
use crate::{
    markdown_projects::{MarkdownProjects, Result, read, regular},
    worker_process::{WorkerChild, document_command},
};
use scenesparrow_domain::contracts::*;
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

fn terms(value: &str) -> BTreeSet<String> {
    let lower = value.chars().take(1024).collect::<String>().to_lowercase();
    let mut result: BTreeSet<_> = lower
        .split(|c: char| !c.is_alphanumeric() || is_cjk(c))
        .filter(|s| {
            s.len() > 2
                && ![
                    "the", "and", "this", "that", "what", "which", "with", "does", "are", "for",
                    "can", "how", "verify", "claim",
                ]
                .contains(s)
        })
        .take(128)
        .map(str::to_owned)
        .collect();
    let chars: Vec<_> = lower.chars().collect();
    for pair in chars.windows(2).filter(|p| p.iter().all(|c| is_cjk(*c))) {
        if result.len() >= 128 {
            break;
        }
        result.insert(pair.iter().collect());
    }
    result
}
fn is_cjk(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{9fff}' | '\u{f900}'..='\u{faff}')
}
fn excerpt(text: &str, terms: &BTreeSet<String>) -> String {
    let lower = text.to_lowercase();
    let position = terms
        .iter()
        .filter_map(|t| lower.find(t))
        .min()
        .unwrap_or(0);
    // Case folding can expand a character; map its byte offset back to original characters.
    let mut folded_bytes = 0;
    let start = text
        .chars()
        .take_while(|c| {
            let before = folded_bytes;
            folded_bytes += c.to_lowercase().map(char::len_utf8).sum::<usize>();
            before < position
        })
        .count()
        .saturating_sub(160);
    text.chars().skip(start).take(1600).collect()
}
impl MarkdownProjects {
    pub(super) fn research_sources(
        &self,
        project: &str,
        question: &str,
        quote: &str,
        cancelled: &AtomicBool,
    ) -> Result<AgentResearch> {
        let query = terms(&format!(
            "{} {}",
            question.chars().take(512).collect::<String>(),
            quote.chars().take(512).collect::<String>()
        ));
        let question_terms = terms(question);
        let mut partial = false;
        let mut sufficient = false;
        let mut ranked = vec![];
        {
            let _guard = self
                .writer
                .lock()
                .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
            let directory = self.validated_directory(project)?.join("references");
            if directory
                .try_exists()
                .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?
            {
                regular(&directory, true)?;
                let mut paths = vec![];
                for entry in std::fs::read_dir(&directory)
                    .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?
                    .take(33)
                {
                    paths.push(entry.map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?.path());
                }
                paths.sort();
                if paths.len() > 32 {
                    paths.truncate(32);
                    partial = true;
                }
                let mut total = 0;
                for path in paths {
                    if cancelled.load(Ordering::Acquire) {
                        return Err("AGENT_TURN_SETTLED");
                    }
                    if !matches!(
                        path.extension().and_then(|s| s.to_str()),
                        Some("md" | "txt")
                    ) {
                        continue;
                    }
                    let text = match read(&path, 32 * 1024).and_then(|bytes| {
                        String::from_utf8(bytes).map_err(|_| "MARKDOWN_TEXT_INVALID")
                    }) {
                        Ok(text) if total + text.len() <= 128 * 1024 => text,
                        _ => {
                            partial = true;
                            continue;
                        }
                    };
                    total += text.len();
                    let lower = text.to_lowercase();
                    let score = query.iter().filter(|t| lower.contains(t.as_str())).count();
                    if score < 2 {
                        continue;
                    }
                    sufficient |= question_terms.is_empty()
                        || question_terms.iter().any(|t| lower.contains(t));
                    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                        partial = true;
                        continue;
                    };
                    let title = text
                        .lines()
                        .find_map(|line| line.trim().strip_prefix("# "))
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or(name)
                        .chars()
                        .take(120)
                        .collect();
                    ranked.push((
                        score,
                        AgentResearchSource {
                            id: format!("references/{name}"),
                            title,
                            url: None,
                            excerpt: excerpt(&text, &query),
                        },
                    ));
                }
            }
        }
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.id.cmp(&b.1.id)));
        ranked.truncate(4);
        let mut sources: Vec<_> = ranked.into_iter().map(|(_, s)| s).collect();
        if !sources.is_empty() && sufficient && !partial {
            return Ok(AgentResearch {
                status: AgentResearchStatus::Complete,
                sources,
            });
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("AGENT_TURN_SETTLED");
        }
        let public = self.research_search.as_deref().and_then(|endpoint| {
            let query = format!(
                "{} {}",
                quote.chars().take(256).collect::<String>(),
                question.chars().take(256).collect::<String>()
            );
            public_search(endpoint, &query, cancelled).ok()
        });
        if cancelled.load(Ordering::Acquire) {
            return Err("AGENT_TURN_SETTLED");
        }
        let status = match public {
            Some(mut public) => {
                sources.append(&mut public.sources);
                sources.truncate(4);
                if partial || (!sources.is_empty() && public.status == AgentResearchStatus::Empty) {
                    AgentResearchStatus::Partial
                } else {
                    public.status
                }
            }
            None if !sources.is_empty() => AgentResearchStatus::Partial,
            None => AgentResearchStatus::Unavailable,
        };
        Ok(AgentResearch { status, sources })
    }
}
fn public_search(endpoint: &str, question: &str, cancelled: &AtomicBool) -> Result<AgentResearch> {
    let entry =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../workers/research/search.mjs");
    let mut child = WorkerChild(
        document_command(&entry)
            .spawn()
            .map_err(|_| "AGENT_RESEARCH_UNAVAILABLE")?,
    );
    let input = serde_json::to_vec(&serde_json::json!({"endpoint":endpoint,"question":question}))
        .map_err(|_| "AGENT_RESEARCH_UNAVAILABLE")?;
    child
        .stdin
        .take()
        .ok_or("AGENT_RESEARCH_UNAVAILABLE")?
        .write_all(&input)
        .map_err(|_| "AGENT_RESEARCH_UNAVAILABLE")?;
    let stdout = child.stdout.take().ok_or("AGENT_RESEARCH_UNAVAILABLE")?;
    let reader = std::thread::spawn(move || {
        let mut output = vec![];
        stdout
            .take(64 * 1024 + 1)
            .read_to_end(&mut output)
            .map(|_| output)
    });
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("AGENT_TURN_SETTLED");
        }
        if started.elapsed() > Duration::from_secs(10) {
            return Err("AGENT_RESEARCH_UNAVAILABLE");
        }
        if let Some(status) = child.try_wait().map_err(|_| "AGENT_RESEARCH_UNAVAILABLE")? {
            if !status.success() {
                return Err("AGENT_RESEARCH_UNAVAILABLE");
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = reader
        .join()
        .map_err(|_| "AGENT_RESEARCH_UNAVAILABLE")?
        .map_err(|_| "AGENT_RESEARCH_UNAVAILABLE")?;
    if output.len() > 64 * 1024 {
        return Err("AGENT_RESEARCH_UNAVAILABLE");
    }
    let research: AgentResearch =
        serde_json::from_slice(&output).map_err(|_| "AGENT_RESEARCH_UNAVAILABLE")?;
    if research.sources.len() > 4 || research.status == AgentResearchStatus::Pending {
        return Err("AGENT_RESEARCH_UNAVAILABLE");
    }
    Ok(research)
}

#[cfg(test)]
mod tests {
    use super::*;
    use scenesparrow_application::external_agent::{
        AgentDelta, AgentDocuments, AgentInput, AgentOutput, AgentSessions, WritingAgent,
    };
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
        sync::Arc,
    };

    fn http(body: &'static str, status: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/search", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            if status == "lost" {
                return request;
            }
            let _ = write!(
                socket,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            request
        });
        (endpoint, task)
    }
    struct Answer;
    impl WritingAgent for Answer {
        fn check(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
        fn run(
            &self,
            input: AgentInput,
            _: Arc<AtomicBool>,
            _: &mut dyn FnMut(AgentDelta) -> Result<()>,
        ) -> Result<AgentOutput> {
            assert!(!input.text.contains("PRIVATE_OUTSIDE"));
            assert!(input.context.batch.is_none());
            let research = input.context.research.unwrap();
            assert_ne!(research.status, AgentResearchStatus::Pending);
            if input.instruction == "Fail after retrieving evidence" {
                return Err("AGENT_FIXTURE_FAILED");
            }
            Ok(AgentOutput {
                reply: if research.sources.is_empty() {
                    "Available sources do not verify this claim.".into()
                } else {
                    format!("Evidence [{}]", research.sources[0].id)
                },
                changes: None,
                replacement: None,
            })
        }
    }
    fn ask(
        store: Arc<MarkdownProjects>,
        text: &str,
        quote: &str,
        question: &str,
    ) -> (AgentSessions, String, String, AgentDispatch) {
        let project = store.create(text.into()).unwrap();
        let sessions = AgentSessions::new(store, Arc::new(Answer));
        let owner = sessions
            .create(
                &project.project_id,
                AgentCreateSession {
                    request_id: "create".into(),
                    engine_id: "fixture".into(),
                    model_id: "fixture".into(),
                },
            )
            .unwrap();
        let start = text.find(quote).unwrap() as i64;
        let (_, dispatch) = sessions
            .start(
                &project.project_id,
                &owner.id,
                AgentSendTurn {
                    request_id: "ask".into(),
                    instruction: question.into(),
                    attachment: AgentAttachment {
                        research: Some(true),
                        kind: MarkdownDocumentKind::Manuscript,
                        revision: Some(project.revision.clone()),
                        source_digest: project.revision,
                        selection: Some(AgentSelection {
                            range: MarkdownRange {
                                start,
                                end: start + quote.len() as i64,
                            },
                            quote: quote.into(),
                        }),
                        buffer: None,
                    },
                },
            )
            .unwrap();
        (sessions, project.project_id, owner.id, dispatch.unwrap())
    }
    use scenesparrow_application::external_agent::AgentDispatch;
    #[test]
    fn reference_matching_is_bounded_and_excerpts_preserve_case_expanding_unicode() {
        let query = (0..10_000).map(|n| format!("term{n} ")).collect::<String>();
        assert!(terms(&query).len() <= 128);
        let text = format!("{}Actual evidence {}", "İ".repeat(2000), "中".repeat(2000));
        let result = excerpt(&text, &terms("Actual evidence"));
        assert!(result.contains("Actual evidence"));
        assert_eq!(result.chars().count(), 1600);
    }
    #[test]
    fn awr_ac08_project_reference_precedes_public_search_and_history_is_durable() {
        let root = tempfile::tempdir().unwrap();
        let mut store = MarkdownProjects::open(root.path()).unwrap();
        store.research_search = Some("https://invalid.invalid/never-called".into());
        let store = Arc::new(store);
        let (sessions, project, id, dispatch) = ask(
            store.clone(),
            "PRIVATE_OUTSIDE 鄱阳湖面积约三千平方公里。 PRIVATE_OUTSIDE",
            "鄱阳湖面积约三千平方公里。",
            "鄱阳湖面积有何依据？",
        );
        let directory = root.path().join(&project).join("references");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(
            directory.join("湖泊调查.md"),
            format!(
                "# 湖泊调查 · Lake survey\n{}鄱阳湖面积随季节变化，三千平方公里只适用于特定水位。",
                "前言。".repeat(600)
            ),
        )
        .unwrap();
        let document = std::fs::read(root.path().join(&project).join("manuscript.md")).unwrap();
        sessions.run(dispatch);
        let saved = sessions.read(&project, &id).unwrap();
        let turn = &saved.turns[0];
        assert_eq!(turn.status, AgentTurnStatus::Completed);
        assert!(turn.proposal.is_none());
        let research = turn.context.research.as_ref().unwrap();
        assert_eq!(research.status, AgentResearchStatus::Complete);
        assert_eq!(research.sources[0].id, "references/湖泊调查.md");
        assert_eq!(research.sources[0].title, "湖泊调查 · Lake survey");
        assert!(research.sources[0].excerpt.contains("鄱阳湖面积随季节变化"));
        assert_eq!(
            std::fs::read(root.path().join(&project).join("manuscript.md")).unwrap(),
            document
        );
        assert!(!root.path().join(&project).join("comments.json").exists());
        drop(sessions);
        let restored = AgentSessions::new(store, Arc::new(Answer))
            .read(&project, &id)
            .unwrap();
        assert_eq!(restored.turns[0].context.research, turn.context.research);
        assert_eq!(restored.turns[0].reply, "Evidence [references/湖泊调查.md]");
    }
    #[test]
    fn awr_ac08_real_http_query_contains_only_bounded_selection_and_question_and_persists_metadata()
    {
        let (endpoint, task) = http(
            r#"{"results":[{"title":"Lake evidence","url":"https://evidence.example/lake","content":"Measured lake area changes seasonally."}]}"#,
            "200 OK",
        );
        let root = tempfile::tempdir().unwrap();
        let mut store = MarkdownProjects::open(root.path()).unwrap();
        store.research_search = Some(endpoint);
        let store = Arc::new(store);
        let (sessions, project, id, dispatch) = ask(
            store.clone(),
            "PRIVATE_OUTSIDE 湖泊面积三千平方公里。 PRIVATE_OUTSIDE",
            "湖泊面积三千平方公里。",
            "这句话有出处吗？",
        );
        sessions.run(dispatch);
        let request = task.join().unwrap();
        let url = url::Url::parse(&format!(
            "http://localhost{}",
            request.split_whitespace().nth(1).unwrap()
        ))
        .unwrap();
        let query = url
            .query_pairs()
            .find(|(k, _)| k == "q")
            .unwrap()
            .1
            .into_owned();
        assert!(query.contains("湖泊面积三千平方公里。"));
        assert!(query.contains("这句话有出处吗？"));
        assert!(!query.contains("PRIVATE_OUTSIDE"));
        let view = sessions.read(&project, &id).unwrap();
        assert_eq!(view.turns[0].status, AgentTurnStatus::Completed);
        let source = &view.turns[0].context.research.as_ref().unwrap().sources[0];
        assert_eq!(source.title, "Lake evidence");
        assert_eq!(source.url.as_deref(), Some("https://evidence.example/lake"));
        drop(sessions);
        assert_eq!(
            store.load_conversation(&project, &id).unwrap().turns[0]
                .context
                .research,
            view.turns[0].context.research
        );
    }
    #[test]
    fn awr_ac09_unavailable_and_empty_results_remain_in_saved_turns() {
        for (body, status, expected) in [
            ("{}", "503 Unavailable", AgentResearchStatus::Unavailable),
            ("{}", "lost", AgentResearchStatus::Unavailable),
            (r#"{"sources":[]}"#, "200 OK", AgentResearchStatus::Empty),
            (
                r#"{"sources":[{"title":"Actual","url":"https://evidence.example","excerpt":"Evidence"},{"url":"javascript:bad"}]}"#,
                "200 OK",
                AgentResearchStatus::Partial,
            ),
        ] {
            let (endpoint, task) = http(body, status);
            let root = tempfile::tempdir().unwrap();
            let mut store = MarkdownProjects::open(root.path()).unwrap();
            store.research_search = Some(endpoint);
            let (sessions, project, id, dispatch) = ask(
                Arc::new(store),
                "Claim text",
                "Claim text",
                "Verify this claim",
            );
            sessions.run(dispatch);
            task.join().unwrap();
            let view = sessions.read(&project, &id).unwrap();
            assert_eq!(
                view.turns[0].context.research.as_ref().unwrap().status,
                expected
            );
            assert!(view.turns[0].proposal.is_none());
        }
    }
    #[test]
    fn awr_ac09_answer_failure_keeps_retrieved_sources_and_retry_context() {
        let (endpoint, task) = http(
            r#"{"sources":[{"title":"Actual evidence","url":"https://evidence.example/source","excerpt":"Retrieved fact"}]}"#,
            "200 OK",
        );
        let root = tempfile::tempdir().unwrap();
        let mut store = MarkdownProjects::open(root.path()).unwrap();
        store.research_search = Some(endpoint);
        let store = Arc::new(store);
        let (sessions, project, id, dispatch) = ask(
            store.clone(),
            "Claim text",
            "Claim text",
            "Fail after retrieving evidence",
        );
        sessions.run(dispatch);
        task.join().unwrap();
        let saved = store.load_conversation(&project, &id).unwrap();
        assert_eq!(saved.turns[0].status, AgentTurnStatus::Failed);
        assert_eq!(
            saved.turns[0].error_code.as_deref(),
            Some("AGENT_FIXTURE_FAILED")
        );
        assert_eq!(
            saved.turns[0].context.research.as_ref().unwrap().sources[0].title,
            "Actual evidence"
        );
        assert_eq!(
            saved.turns[0].attachment.selection.as_ref().unwrap().quote,
            "Claim text"
        );
        assert!(saved.turns[0].proposal.is_none());
    }
    #[test]
    fn awr_ac09_cancellation_kills_real_search_and_keeps_retry_input() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/search", listener.local_addr().unwrap());
        let root = tempfile::tempdir().unwrap();
        let mut store = MarkdownProjects::open(root.path()).unwrap();
        store.research_search = Some(endpoint);
        let (sessions, project, id, dispatch) = ask(
            Arc::new(store),
            "Claim text",
            "Claim text",
            "Verify this claim",
        );
        let sessions = Arc::new(sessions);
        let turn = dispatch.input.turn_id.clone();
        let owner = sessions.clone();
        let work = std::thread::spawn(move || owner.run(dispatch));
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let started = Instant::now();
        sessions.cancel(&project, &id, &turn).unwrap();
        work.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        let view = sessions.read(&project, &id).unwrap();
        assert_eq!(view.turns[0].status, AgentTurnStatus::Cancelled);
        assert_eq!(
            view.turns[0].context.research.as_ref().unwrap().status,
            AgentResearchStatus::Cancelled
        );
        assert_eq!(view.turns[0].instruction, "Verify this claim");
        assert_eq!(
            view.turns[0].attachment.selection.as_ref().unwrap().quote,
            "Claim text"
        );
        let _ = socket.write_all(b"late response");
        assert!(view.turns[0].proposal.is_none());
    }
}

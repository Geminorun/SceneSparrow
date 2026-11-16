use scenesparrow_infrastructure::SqliteProjectRepository;
use std::{
    env,
    net::{Ipv4Addr, SocketAddrV4},
    path::PathBuf,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("--inspect-project") && args.len() == 3 {
        SqliteProjectRepository::inspect_available_project(std::path::Path::new(&args[2]))?;
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--recover-project") && args.len() == 4 {
        drop(SqliteProjectRepository::restore_verified_copy(
            std::path::Path::new(&args[2]),
            std::path::Path::new(&args[3]),
        )?);
        return Ok(());
    }
    let token = env::var("SCENESPARROW_SESSION_TOKEN")
        .map_err(|_| "SCENESPARROW_SESSION_TOKEN is required")?;
    if token.len() < 32 || !token.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Session token must contain at least 32 ASCII letters or digits".into());
    }
    let directory = PathBuf::from(
        env::var("SCENESPARROW_PROJECT_DIR").unwrap_or_else(|_| ".local/project".to_owned()),
    );
    let port: u16 = env::var("SCENESPARROW_CORE_PORT")
        .unwrap_or_else(|_| "4318".to_owned())
        .parse()?;
    let origin =
        env::var("SCENESPARROW_WEB_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:5173".to_owned());
    let repository = match env::var("SCENESPARROW_PROJECT_OPEN_MODE") {
        Ok(mode) if mode == "existing" => SqliteProjectRepository::open_existing(&directory)?,
        Ok(mode) if mode == "create" => SqliteProjectRepository::open(&directory)?,
        Err(env::VarError::NotPresent) => SqliteProjectRepository::open(&directory)?,
        _ => return Err("SCENESPARROW_PROJECT_OPEN_MODE must be existing or create".into()),
    };
    let listener =
        tokio::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await?;
    println!(
        "SceneSparrow core is listening on {}",
        listener.local_addr()?
    );
    axum::serve(
        listener,
        scenesparrow_service::router(repository, &token, &origin),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}

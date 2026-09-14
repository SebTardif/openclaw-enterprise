use std::fs;
use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum, ValueHint};
use miette::{Context, IntoDiagnostic, Result, miette};
use occ_client::{ClientConfig, OccClient};
use serde_json::{Value, json};
use url::Url;

const DEFAULT_TIMEOUT_SECONDS: u64 = 30;

/// Manage `OpenClaw` Control Plane resources.
#[derive(Debug, Parser)]
#[command(name = "occ", version, about, propagate_version = true)]
struct Cli {
    /// OCC endpoint URL.
    #[arg(long, global = true, env = "OCC_URL", value_name = "URL")]
    url: Option<Url>,

    /// Bootstrap or service-key response file.
    #[arg(long, global = true, env = "OCC_SERVICE_KEY_FILE", value_name = "PATH", value_hint = ValueHint::FilePath)]
    service_key_file: Option<PathBuf>,

    /// Additional PEM trust bundle for the OCC endpoint.
    #[arg(long, global = true, env = "OCC_CA_BUNDLE", value_name = "PATH", value_hint = ValueHint::FilePath)]
    ca_bundle: Option<PathBuf>,

    /// Request timeout in seconds.
    #[arg(long, global = true, env = "OCC_TIMEOUT_SECONDS", default_value_t = DEFAULT_TIMEOUT_SECONDS, value_name = "SECONDS", value_parser = clap::value_parser!(u64).range(1..))]
    timeout_seconds: u64,

    /// Namespace scope for Configuration and Agent operations.
    #[arg(long, global = true, env = "OCC_NAMESPACE", value_name = "ID")]
    namespace: Option<String>,

    /// Output format.
    #[arg(short = 'o', long, global = true, value_enum, default_value_t = OutputFormat::Table)]
    output: OutputFormat,

    #[command(subcommand)]
    command: Command,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum OutputFormat {
    Table,
    Json,
    Yaml,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Inspect the singleton Installation.
    Installation {
        #[command(subcommand)]
        command: InstallationCommand,
    },
    /// Manage Namespaces.
    Namespace {
        #[command(subcommand)]
        command: NamespaceCommand,
    },
    /// Manage Configurations in the selected Namespace.
    Configuration {
        #[command(subcommand)]
        command: ConfigurationCommand,
    },
    /// Manage Agents in the selected Namespace.
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
}

#[derive(Debug, Subcommand)]
enum InstallationCommand {
    /// Show the Installation.
    Get,
}

#[derive(Debug, Subcommand)]
enum NamespaceCommand {
    /// Create a Namespace.
    Create {
        /// Namespace name.
        name: String,
        /// Adopt this existing Kubernetes namespace.
        #[arg(long)]
        existing_namespace: Option<String>,
    },
    /// List authorized Namespaces.
    List,
    /// Show a Namespace.
    Get { id: String },
    /// Begin deleting an empty Namespace.
    Delete { id: String },
}

#[derive(Debug, Subcommand)]
enum ConfigurationCommand {
    /// Create a Configuration from a JSON document.
    Create {
        #[arg(long, value_hint = ValueHint::FilePath)]
        file: PathBuf,
    },
    /// Show a Configuration.
    Get { id: String },
    /// Update a Configuration from a JSON document.
    Update {
        id: String,
        #[arg(long, value_hint = ValueHint::FilePath)]
        file: PathBuf,
    },
    /// Delete an unreferenced Configuration.
    Delete { id: String },
}

#[derive(Debug, Subcommand)]
enum AgentCommand {
    /// Create an Agent from a JSON document.
    Create {
        #[arg(long, value_hint = ValueHint::FilePath)]
        file: PathBuf,
    },
    /// List Agents.
    List,
    /// Show an Agent.
    Get { id: String },
    /// Update an Agent from a JSON document.
    Update {
        id: String,
        #[arg(long, value_hint = ValueHint::FilePath)]
        file: PathBuf,
    },
    /// Deploy an Agent and create an immutable revision.
    Deploy { id: String },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let url = cli
        .url
        .ok_or_else(|| miette!("set OCC_URL or pass --url"))?;
    let service_key_file = cli
        .service_key_file
        .ok_or_else(|| miette!("set OCC_SERVICE_KEY_FILE or pass --service-key-file"))?;
    let client = OccClient::connect(
        ClientConfig::new(url, service_key_file)
            .ca_bundle(cli.ca_bundle)
            .timeout_seconds(cli.timeout_seconds),
    )?;

    run_command(&client, cli.output, cli.namespace.as_deref(), cli.command).await
}

async fn run_command(
    client: &OccClient,
    output: OutputFormat,
    namespace: Option<&str>,
    command: Command,
) -> Result<()> {
    match command {
        Command::Installation { command } => match command {
            InstallationCommand::Get => {
                let installation = client.get_installation().await?;
                print_items(
                    output,
                    &installation,
                    false,
                    &[("ID", "id"), ("NAME", "name"), ("CREATED", "createdAt")],
                )?;
            }
        },
        Command::Namespace { command } => run_namespace(client, output, command).await?,
        Command::Configuration { command } => {
            run_configuration(client, output, required_namespace(namespace)?, command).await?;
        }
        Command::Agent { command } => {
            run_agent(client, output, required_namespace(namespace)?, command).await?;
        }
    }
    Ok(())
}

async fn run_namespace(
    client: &OccClient,
    output: OutputFormat,
    command: NamespaceCommand,
) -> Result<()> {
    match command {
        NamespaceCommand::Create {
            name,
            existing_namespace,
        } => {
            let namespace = client
                .create_namespace(&name, existing_namespace.as_deref())
                .await?;
            print_namespace(output, &namespace, false)?;
        }
        NamespaceCommand::List => {
            print_namespace(output, &client.list_namespaces().await?, true)?;
        }
        NamespaceCommand::Get { id } => {
            print_namespace(output, &client.get_namespace(&id).await?, false)?;
        }
        NamespaceCommand::Delete { id } => {
            print_namespace(output, &client.delete_namespace(&id).await?, false)?;
        }
    }
    Ok(())
}

async fn run_configuration(
    client: &OccClient,
    output: OutputFormat,
    namespace: &str,
    command: ConfigurationCommand,
) -> Result<()> {
    match command {
        ConfigurationCommand::Create { file } => {
            let configuration = client
                .create_configuration(namespace, &read_json(&file)?)
                .await?;
            print_configuration(output, &configuration)?;
        }
        ConfigurationCommand::Get { id } => {
            print_configuration(output, &client.get_configuration(namespace, &id).await?)?;
        }
        ConfigurationCommand::Update { id, file } => {
            let configuration = client
                .update_configuration(namespace, &id, &read_json(&file)?)
                .await?;
            print_configuration(output, &configuration)?;
        }
        ConfigurationCommand::Delete { id } => {
            client.delete_configuration(namespace, &id).await?;
            print_deletion(output, "configuration", &id)?;
        }
    }
    Ok(())
}

async fn run_agent(
    client: &OccClient,
    output: OutputFormat,
    namespace: &str,
    command: AgentCommand,
) -> Result<()> {
    match command {
        AgentCommand::Create { file } => print_agent(
            output,
            &client.create_agent(namespace, &read_json(&file)?).await?,
            false,
        )?,
        AgentCommand::List => {
            print_agent(output, &client.list_agents(namespace).await?, true)?;
        }
        AgentCommand::Get { id } => {
            print_agent(output, &client.get_agent(namespace, &id).await?, false)?;
        }
        AgentCommand::Update { id, file } => print_agent(
            output,
            &client
                .update_agent(namespace, &id, &read_json(&file)?)
                .await?,
            false,
        )?,
        AgentCommand::Deploy { id } => {
            let revision = client.deploy_agent(namespace, &id).await?;
            print_items(
                output,
                &revision,
                false,
                &[
                    ("ID", "id"),
                    ("REVISION", "revision"),
                    ("AGENT", "agentId"),
                    ("CONFIGURATION", "configurationId"),
                ],
            )?;
        }
    }
    Ok(())
}

fn required_namespace(namespace: Option<&str>) -> Result<&str> {
    namespace.ok_or_else(|| miette!("set OCC_NAMESPACE or pass --namespace"))
}

fn read_json(path: &PathBuf) -> Result<Value> {
    let bytes = fs::read(path)
        .into_diagnostic()
        .wrap_err_with(|| format!("failed to read JSON file {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .into_diagnostic()
        .wrap_err_with(|| format!("invalid JSON file {}", path.display()))
}

fn print_namespace(output: OutputFormat, value: &Value, collection: bool) -> Result<()> {
    print_items(
        output,
        value,
        collection,
        &[
            ("ID", "id"),
            ("NAME", "name"),
            ("STATUS", "status"),
            ("KUBERNETES NAMESPACE", "existingNamespace"),
        ],
    )
}

fn print_configuration(output: OutputFormat, value: &Value) -> Result<()> {
    print_items(
        output,
        value,
        false,
        &[
            ("ID", "id"),
            ("KIND", "kind"),
            ("GENERATION", "generation"),
            ("CREATED", "createdAt"),
        ],
    )
}

fn print_agent(output: OutputFormat, value: &Value, collection: bool) -> Result<()> {
    print_items(
        output,
        value,
        collection,
        &[
            ("ID", "id"),
            ("NAME", "name"),
            ("CONFIGURATION", "configurationId"),
            ("MODE", "executionMode"),
            ("ACTIVE REVISION", "activeRevisionId"),
        ],
    )
}

fn print_deletion(output: OutputFormat, kind: &str, id: &str) -> Result<()> {
    let value = json!({ "deleted": true, "kind": kind, "id": id });
    match output {
        OutputFormat::Table => println!("Deleted {kind} {id}."),
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&value).into_diagnostic()?
        ),
        OutputFormat::Yaml => print!("{}", serde_yml::to_string(&value).into_diagnostic()?),
    }
    Ok(())
}

fn print_items(
    output: OutputFormat,
    value: &Value,
    collection: bool,
    columns: &[(&str, &str)],
) -> Result<()> {
    match output {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(value).into_diagnostic()?);
        }
        OutputFormat::Yaml => print!("{}", serde_yml::to_string(value).into_diagnostic()?),
        OutputFormat::Table => {
            let items = if collection {
                value
                    .as_array()
                    .ok_or_else(|| miette!("OCC returned an invalid resource collection"))?
                    .iter()
                    .collect::<Vec<_>>()
            } else {
                vec![value]
            };
            print_table(&items, columns)?;
        }
    }
    Ok(())
}

fn print_table(items: &[&Value], columns: &[(&str, &str)]) -> Result<()> {
    if items.is_empty() {
        println!("No resources found.");
        return Ok(());
    }
    let rows = items
        .iter()
        .map(|item| {
            let object = item
                .as_object()
                .ok_or_else(|| miette!("OCC returned an invalid resource"))?;
            Ok(columns
                .iter()
                .map(|(_, key)| display_value(object.get(*key)))
                .collect::<Vec<_>>())
        })
        .collect::<Result<Vec<_>>>()?;
    let widths = columns
        .iter()
        .enumerate()
        .map(|(index, (title, _))| {
            rows.iter()
                .map(|row| row[index].len())
                .max()
                .unwrap_or(0)
                .max(title.len())
        })
        .collect::<Vec<_>>();
    print_row(
        &columns
            .iter()
            .map(|(title, _)| (*title).to_string())
            .collect::<Vec<_>>(),
        &widths,
    );
    for row in rows {
        print_row(&row, &widths);
    }
    Ok(())
}

fn display_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "-".to_string(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
    }
}

fn print_row(row: &[String], widths: &[usize]) {
    for (index, value) in row.iter().enumerate() {
        if index > 0 {
            print!("  ");
        }
        print!("{value:<width$}", width = widths[index]);
    }
    println!();
}

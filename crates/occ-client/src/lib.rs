use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use miette::{Context, IntoDiagnostic, Result, miette};
use reqwest::{Client, Method, StatusCode, redirect};
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

const DEFAULT_TIMEOUT_SECONDS: u64 = 30;

/// Connection, authentication, and TLS settings for an OCC client.
#[derive(Debug)]
pub struct ClientConfig {
    url: Url,
    service_key_file: PathBuf,
    ca_bundle: Option<PathBuf>,
    timeout_seconds: u64,
}

impl ClientConfig {
    #[must_use]
    pub fn new(url: Url, service_key_file: PathBuf) -> Self {
        Self {
            url,
            service_key_file,
            ca_bundle: None,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
        }
    }

    #[must_use]
    pub fn ca_bundle(mut self, ca_bundle: Option<PathBuf>) -> Self {
        self.ca_bundle = ca_bundle;
        self
    }

    #[must_use]
    pub fn timeout_seconds(mut self, timeout_seconds: u64) -> Self {
        self.timeout_seconds = timeout_seconds;
        self
    }
}

/// High-level client for supported OCC resource operations.
#[derive(Debug, Clone)]
pub struct OccClient {
    base_url: Url,
    service_key: String,
    http: Client,
}

#[derive(Debug, Deserialize)]
struct ServiceKeyEnvelope {
    data: ServiceKeyData,
}

#[derive(Debug, Deserialize)]
struct ServiceKeyData {
    key: String,
}

#[derive(Debug, Deserialize)]
struct ResponseEnvelope {
    data: Value,
    #[serde(rename = "meta")]
    _meta: Value,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: ApiError,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    code: String,
    message: String,
}

impl OccClient {
    /// Create a client after validating its origin, credentials, and TLS inputs.
    ///
    /// # Errors
    ///
    /// Returns an error when configuration, credentials, or TLS inputs are invalid.
    pub fn connect(config: ClientConfig) -> Result<Self> {
        validate_origin(&config.url)?;
        let service_key = read_service_key(&config.service_key_file)?;
        let http = http_client(config.ca_bundle.as_deref(), config.timeout_seconds)?;
        Ok(Self {
            base_url: config.url,
            service_key,
            http,
        })
    }

    /// Fetch the singleton Installation.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn get_installation(&self) -> Result<Value> {
        self.get(&["installation"]).await
    }

    /// Create a Namespace.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn create_namespace(
        &self,
        name: &str,
        existing_namespace: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "name": name });
        if let Some(existing_namespace) = existing_namespace {
            body["existingNamespace"] = Value::String(existing_namespace.to_string());
        }
        self.send(Method::POST, &["namespaces"], Some(&body)).await
    }

    /// List authorized Namespaces.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn list_namespaces(&self) -> Result<Value> {
        self.get(&["namespaces"]).await
    }

    /// Fetch a Namespace.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn get_namespace(&self, namespace_id: &str) -> Result<Value> {
        self.get(&["namespaces", namespace_id]).await
    }

    /// Begin deleting a Namespace.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn delete_namespace(&self, namespace_id: &str) -> Result<Value> {
        self.send(Method::DELETE, &["namespaces", namespace_id], None)
            .await
    }

    /// Create a Configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn create_configuration(&self, namespace_id: &str, body: &Value) -> Result<Value> {
        self.send(
            Method::POST,
            &["namespaces", namespace_id, "configurations"],
            Some(body),
        )
        .await
    }

    /// Fetch a Configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn get_configuration(
        &self,
        namespace_id: &str,
        configuration_id: &str,
    ) -> Result<Value> {
        self.get(&[
            "namespaces",
            namespace_id,
            "configurations",
            configuration_id,
        ])
        .await
    }

    /// Update a Configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn update_configuration(
        &self,
        namespace_id: &str,
        configuration_id: &str,
        body: &Value,
    ) -> Result<Value> {
        self.send(
            Method::PATCH,
            &[
                "namespaces",
                namespace_id,
                "configurations",
                configuration_id,
            ],
            Some(body),
        )
        .await
    }

    /// Delete an unreferenced Configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn delete_configuration(
        &self,
        namespace_id: &str,
        configuration_id: &str,
    ) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &[
                "namespaces",
                namespace_id,
                "configurations",
                configuration_id,
            ],
        )
        .await
    }

    /// Create an Agent.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn create_agent(&self, namespace_id: &str, body: &Value) -> Result<Value> {
        self.send(
            Method::POST,
            &["namespaces", namespace_id, "agents"],
            Some(body),
        )
        .await
    }

    /// List Agents in a Namespace.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn list_agents(&self, namespace_id: &str) -> Result<Value> {
        self.get(&["namespaces", namespace_id, "agents"]).await
    }

    /// Fetch an Agent.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn get_agent(&self, namespace_id: &str, agent_id: &str) -> Result<Value> {
        self.get(&["namespaces", namespace_id, "agents", agent_id])
            .await
    }

    /// Update an Agent.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn update_agent(
        &self,
        namespace_id: &str,
        agent_id: &str,
        body: &Value,
    ) -> Result<Value> {
        self.send(
            Method::PATCH,
            &["namespaces", namespace_id, "agents", agent_id],
            Some(body),
        )
        .await
    }

    /// Deploy an Agent and create an immutable revision.
    ///
    /// # Errors
    ///
    /// Returns an error when OCC rejects the operation or returns an invalid response.
    pub async fn deploy_agent(&self, namespace_id: &str, agent_id: &str) -> Result<Value> {
        self.send(
            Method::POST,
            &["namespaces", namespace_id, "agents", agent_id, "deploy"],
            None,
        )
        .await
    }

    async fn get(&self, segments: &[&str]) -> Result<Value> {
        self.send(Method::GET, segments, None).await
    }

    async fn send(&self, method: Method, segments: &[&str], body: Option<&Value>) -> Result<Value> {
        let (status, bytes) = self.execute(method, segments, body).await?;
        if !status.is_success() {
            return Err(api_error(status, &bytes));
        }
        let envelope: ResponseEnvelope = serde_json::from_slice(&bytes)
            .into_diagnostic()
            .wrap_err_with(|| {
                format!(
                    "OCC returned an invalid response (HTTP {})",
                    status.as_u16()
                )
            })?;
        Ok(envelope.data)
    }

    async fn send_empty(&self, method: Method, segments: &[&str]) -> Result<()> {
        let (status, bytes) = self.execute(method, segments, None).await?;
        if !status.is_success() {
            return Err(api_error(status, &bytes));
        }
        if status != StatusCode::NO_CONTENT || !bytes.is_empty() {
            return Err(miette!(
                "OCC returned an invalid empty response (HTTP {})",
                status.as_u16()
            ));
        }
        Ok(())
    }

    async fn execute(
        &self,
        method: Method,
        segments: &[&str],
        body: Option<&Value>,
    ) -> Result<(StatusCode, Vec<u8>)> {
        let url = resource_url(&self.base_url, segments)?;
        let mut request = self
            .http
            .request(method, url)
            .header("x-api-key", &self.service_key);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .into_diagnostic()
            .wrap_err("OCC operation failed")?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .into_diagnostic()
            .wrap_err("failed to read the OCC response")?;
        Ok((status, bytes.to_vec()))
    }
}

fn validate_origin(url: &Url) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(miette!("OCC URL must use http or https"));
    }
    if url.cannot_be_a_base()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(miette!(
            "OCC URL must be an origin without credentials, a path, a query, or a fragment"
        ));
    }
    Ok(())
}

fn resource_url(base_url: &Url, segments: &[&str]) -> Result<Url> {
    let mut url = base_url.clone();
    let mut path = url
        .path_segments_mut()
        .map_err(|()| miette!("OCC URL cannot be used as an origin"))?;
    path.clear();
    for segment in segments {
        if segment.is_empty() {
            return Err(miette!("OCC resource identifier cannot be empty"));
        }
        path.push(segment);
    }
    drop(path);
    Ok(url)
}

fn api_error(status: StatusCode, body: &[u8]) -> miette::Report {
    match serde_json::from_slice::<ErrorEnvelope>(body) {
        Ok(envelope) => miette!(
            "OCC operation failed (HTTP {}): {}: {}",
            status.as_u16(),
            envelope.error.code,
            envelope.error.message
        ),
        Err(_) => miette!("OCC operation failed (HTTP {})", status.as_u16()),
    }
}

fn read_service_key(path: &Path) -> Result<String> {
    let bytes = fs::read(path)
        .into_diagnostic()
        .wrap_err_with(|| format!("failed to read service-key file {}", path.display()))?;
    let envelope: ServiceKeyEnvelope = serde_json::from_slice(&bytes)
        .into_diagnostic()
        .wrap_err_with(|| format!("invalid service-key file {}", path.display()))?;
    let key = envelope.data.key;
    if key.trim().is_empty() || key.contains(['\r', '\n']) {
        return Err(miette!("invalid service-key file {}", path.display()));
    }
    Ok(key)
}

fn http_client(ca_bundle: Option<&Path>, timeout_seconds: u64) -> Result<Client> {
    let mut builder = Client::builder()
        .redirect(redirect::Policy::none())
        .timeout(Duration::from_secs(timeout_seconds));

    if let Some(path) = ca_bundle {
        let pem = fs::read(path)
            .into_diagnostic()
            .wrap_err_with(|| format!("failed to read CA bundle {}", path.display()))?;
        let certificates = reqwest::Certificate::from_pem_bundle(&pem)
            .into_diagnostic()
            .wrap_err_with(|| format!("invalid CA bundle {}", path.display()))?;
        if certificates.is_empty() {
            return Err(miette!(
                "CA bundle {} contains no certificates",
                path.display()
            ));
        }
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }

    builder
        .build()
        .into_diagnostic()
        .wrap_err("failed to initialize the OCC client")
}

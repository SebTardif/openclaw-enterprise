const dummyWorkspaceId = "00000000-0000-4000-8000-000000000000";
const workspaceId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    process.env.OCC_PROBE_WORKSPACE_ID ?? "",
  )
    ? process.env.OCC_PROBE_WORKSPACE_ID
    : dummyWorkspaceId;

const url = `https://api.chatgpt.com/v1/manage/workspaces/${workspaceId}/service-accounts`;

function cleanHeader(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.split(";")[0].trim().slice(0, 80);
}

function safeToken(value) {
  if (typeof value !== "string") return null;
  if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(value)) return "<present-unlogged>";
  return value;
}

function errorSummary(body) {
  try {
    const parsed = JSON.parse(body);
    const error =
      typeof parsed?.error === "object" && parsed.error !== null ? parsed.error : parsed;
    return {
      error_code: safeToken(error.code),
      error_type: safeToken(error.type),
      error_category: safeToken(error.category),
    };
  } catch {
    return {
      error_code: null,
      error_type: null,
      error_category: null,
    };
  }
}

try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "occ-unauthenticated-probe" }),
  });
  const body = await response.text();
  console.log(
    JSON.stringify(
      {
        network: "reached_http",
        status: response.status,
        content_type: cleanHeader(response.headers.get("content-type")),
        used_repo_variable: workspaceId !== dummyWorkspaceId,
        ...errorSummary(body),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(
    JSON.stringify(
      {
        network: "request_failed",
        error_name: safeToken(error?.name),
        error_code: safeToken(error?.code),
        cause_code: safeToken(error?.cause?.code),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

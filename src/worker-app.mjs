import { MediaInputError } from "./media-input.mjs";

const MAX_BODY_BYTES = 1_048_576;

export function createWorkerApp({ ingestService, versionConfig }) {
  return Object.freeze({
    async fetch(request, env) {
      const requestId =
        request.headers.get("x-request-id") ?? crypto.randomUUID();

      try {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
          return jsonResponse(
            {
              ok: true,
              service: "bn-api",
              ruleset_version: versionConfig.release.version,
            },
            200,
            requestId,
          );
        }

        if (request.method === "POST" && url.pathname === "/v1/media") {
          assertAuthorized(request, env);
          assertJsonRequest(request);
          assertBodySize(request);
          if (!env.DB) {
            throw new HttpError(503, "database binding DB is not configured");
          }

          const payload = await readJson(request);
          const result = await ingestService.ingest(env.DB, payload);
          return jsonResponse(
            { data: result },
            result.outcome === "created" ? 201 : 200,
            requestId,
          );
        }

        return jsonResponse(
          { error: { code: "not_found", message: "route not found" } },
          404,
          requestId,
        );
      } catch (error) {
        if (error instanceof MediaInputError) {
          return jsonResponse(
            {
              error: {
                code: "invalid_media_payload",
                message: error.message,
                details: error.details,
              },
            },
            400,
            requestId,
          );
        }
        if (error instanceof HttpError) {
          return jsonResponse(
            {
              error: {
                code: error.code,
                message: error.message,
              },
            },
            error.status,
            requestId,
          );
        }

        console.error("unhandled worker error", {
          message: error?.message,
          requestId,
          stack: error?.stack,
        });
        return jsonResponse(
          {
            error: {
              code: "internal_error",
              message: "internal server error",
            },
          },
          500,
          requestId,
        );
      }
    },
  });
}

class HttpError extends Error {
  constructor(status, message, code = statusCode(status)) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function assertAuthorized(request, env) {
  if (!env.INGEST_TOKEN) {
    throw new HttpError(
      503,
      "INGEST_TOKEN is not configured",
      "service_not_configured",
    );
  }
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${env.INGEST_TOKEN}`) {
    throw new HttpError(401, "invalid bearer token", "unauthorized");
  }
}

function assertJsonRequest(request) {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(
      415,
      "content-type must be application/json",
      "unsupported_media_type",
    );
  }
}

function assertBodySize(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body is too large", "payload_too_large");
  }
}

async function readJson(request) {
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body is too large", "payload_too_large");
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new HttpError(400, "request body must be valid JSON", "invalid_json");
  }
}

function jsonResponse(body, status, requestId) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
    },
  });
}

function statusCode(status) {
  return `http_${status}`;
}

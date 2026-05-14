import { rowId } from "./format";
import type { BodyMode, HttpMethod, KeyValueRow, RequestDraft } from "../types";

const methods: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function parseCurl(input: string, baseDraft: RequestDraft): RequestDraft {
  const tokens = tokenizeCurl(input.replace(/\\\r?\n/g, " "));
  if (tokens.length === 0 || tokens[0].toLowerCase() !== "curl") {
    throw new Error("请输入以 curl 开头的命令。");
  }

  let method: HttpMethod | undefined;
  let url = "";
  let body = "";
  let bodyMode: BodyMode = "none";
  const headers: KeyValueRow[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];

    if (token === "-X" || token === "--request") {
      method = normalizeMethod(next);
      index += 1;
      continue;
    }

    if (token === "-H" || token === "--header") {
      if (next) {
        const separator = next.indexOf(":");
        headers.push({
          id: rowId("header"),
          enabled: true,
          key: separator >= 0 ? next.slice(0, separator).trim() : next.trim(),
          value: separator >= 0 ? next.slice(separator + 1).trim() : "",
          description: "",
        });
        index += 1;
      }
      continue;
    }

    if (token === "-d" || token === "--data" || token === "--data-raw" || token === "--data-binary") {
      body = next ?? "";
      bodyMode = detectBodyMode(headers, body);
      method ??= "POST";
      index += 1;
      continue;
    }

    if (token === "--url") {
      url = next ?? "";
      index += 1;
      continue;
    }

    if (!token.startsWith("-") && !url) {
      url = token;
    }
  }

  if (!url) {
    throw new Error("没有在 cURL 中找到 URL。");
  }

  return {
    ...baseDraft,
    id: undefined,
    name: "导入的请求",
    method: method ?? "GET",
    url,
    headers: ensureTrailingRow(headers, "header"),
    params: [emptyRow("param")],
    body,
    bodyMode,
  };
}

export function draftToCurl(draft: RequestDraft): string {
  const lines = [`curl -X ${draft.method} ${quoteShell(draft.url || "https://api.example.com")}`];

  for (const header of draft.headers.filter((row) => row.enabled && row.key.trim())) {
    lines.push(`  -H ${quoteShell(`${header.key}: ${header.value}`)}`);
  }

  if (draft.bodyMode !== "none" && draft.body.trim()) {
    lines.push(`  --data-raw ${quoteShell(draft.body)}`);
  }

  return lines.join(" \\\n");
}

function tokenizeCurl(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && index + 1 < input.length) {
        index += 1;
        current += input[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\" && index + 1 < input.length) {
      index += 1;
      current += input[index];
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function normalizeMethod(value?: string): HttpMethod {
  const method = value?.toUpperCase();
  if (methods.includes(method as HttpMethod)) {
    return method as HttpMethod;
  }
  return "GET";
}

function detectBodyMode(headers: KeyValueRow[], body: string): BodyMode {
  const contentType = headers.find((row) => row.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  if (contentType.includes("json")) return "json";
  if (contentType.includes("xml")) return "xml";
  if (contentType.includes("x-www-form-urlencoded")) return "x-www-form-urlencoded";
  if (body.trim().startsWith("{") || body.trim().startsWith("[")) return "json";
  return "raw";
}

function ensureTrailingRow(rows: KeyValueRow[], prefix: string): KeyValueRow[] {
  return rows.length > 0 ? [...rows, emptyRow(prefix)] : [emptyRow(prefix)];
}

function emptyRow(prefix: string): KeyValueRow {
  return {
    id: rowId(prefix),
    enabled: true,
    key: "",
    value: "",
    description: "",
  };
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

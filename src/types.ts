export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type KeyValueRow = {
  id: string;
  enabled: boolean;
  key: string;
  value: string;
  description?: string;
  secret?: boolean;
};

export type BodyMode =
  | "none"
  | "json"
  | "form-data"
  | "x-www-form-urlencoded"
  | "raw"
  | "xml"
  | "binary"
  | "graphql";

export type RequestDraft = {
  id?: string;
  name: string;
  collectionId?: string;
  method: HttpMethod;
  url: string;
  params: KeyValueRow[];
  headers: KeyValueRow[];
  bodyMode: BodyMode;
  body: string;
  timeoutMs: number;
  environmentId?: string;
  mockConfig?: MockConfig;
  scripts?: ScriptConfig;
};

export type MockConfig = {
  enabled: boolean;
  statusCode: number;
  delayMs: number;
  headers: KeyValueRow[];
  body: string;
};

export type ScriptConfig = {
  enabled: boolean;
  preRequest: string;
  postResponse: string;
};

export type HttpRequestPayload = {
  method: HttpMethod;
  url: string;
  params: KeyValueRow[];
  headers: KeyValueRow[];
  bodyMode: BodyMode;
  body: string;
  timeoutMs: number;
  environmentId?: string;
};

export type HttpResponsePayload = {
  status: number;
  statusText: string;
  headers: KeyValueRow[];
  body: string;
  durationMs: number;
  sizeBytes: number;
  url: string;
};

export type Collection = {
  id: string;
  name: string;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  requestCount: number;
};

export type SavedRequest = RequestDraft & {
  id: string;
  collectionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type Variable = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  secret: boolean;
  description?: string;
};

export type Environment = {
  id: string;
  name: string;
  variables: Variable[];
  createdAt: string;
  updatedAt: string;
};

export type HistoryEntry = {
  id: string;
  method: HttpMethod;
  url: string;
  status?: number;
  durationMs?: number;
  createdAt: string;
  draft: RequestDraft;
};

export type LogLevel = "info" | "success" | "warn" | "error" | "script" | "assert-pass" | "assert-fail";

export type LogStage = "request" | "response" | "mock" | "pre-script" | "post-script" | "script-log" | "error";

export type LogEntry = {
  id: string;
  requestId?: string;
  requestName?: string;
  method?: HttpMethod;
  url?: string;
  status?: number;
  durationMs?: number;
  sizeBytes?: number;
  level: LogLevel;
  stage: LogStage;
  message: string;
  requestBody?: string;
  responseBody?: string;
  createdAt: string;
};

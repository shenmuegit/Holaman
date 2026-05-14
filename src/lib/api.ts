import { invoke } from "@tauri-apps/api/core";
import type {
  Collection,
  Environment,
  HistoryEntry,
  HttpRequestPayload,
  HttpResponsePayload,
  LogEntry,
  RequestDraft,
  SavedRequest,
} from "../types";

const isTauri = "__TAURI_INTERNALS__" in window;
const localCollections: Collection[] = [];
const localSavedRequests: SavedRequest[] = [];
const localEnvironments: Environment[] = [];
const localLogs: LogEntry[] = [];
let localEnvironmentsInitialized = false;

const demoResponse = async (payload: HttpRequestPayload): Promise<HttpResponsePayload> => {
  const started = performance.now();
  await new Promise((resolve) => window.setTimeout(resolve, 420));
  const body = JSON.stringify(
    {
      message: "Holaman 桌面核心已准备好通过 Tauri 接收这个请求。",
      method: payload.method,
      url: payload.url,
      bodyMode: payload.bodyMode,
    },
    null,
    2,
  );

  return {
    status: 200,
    statusText: "OK",
    headers: [
      { id: "content-type", enabled: true, key: "content-type", value: "application/json" },
      { id: "x-holaman-mode", enabled: true, key: "x-holaman-mode", value: "browser-preview" },
    ],
    body,
    durationMs: Math.round(performance.now() - started),
    sizeBytes: new Blob([body]).size,
    url: payload.url,
  };
};

export async function sendHttpRequest(payload: HttpRequestPayload): Promise<HttpResponsePayload> {
  if (!isTauri) {
    return demoResponse(payload);
  }

  return invoke<HttpResponsePayload>("send_http_request", { payload });
}

export async function listCollections(): Promise<Collection[]> {
  if (!isTauri) return localCollections;
  return invoke<Collection[]>("list_collections");
}

export async function saveCollection(name: string, parentId?: string): Promise<Collection> {
  const now = new Date().toISOString();
  if (!isTauri) {
    const collection = { id: crypto.randomUUID(), name, parentId, createdAt: now, updatedAt: now, requestCount: 0 };
    localCollections.unshift(collection);
    return collection;
  }

  return invoke<Collection>("save_collection", { name, parentId: parentId ?? null });
}

export async function renameCollection(id: string, name: string): Promise<Collection> {
  const now = new Date().toISOString();
  if (!isTauri) {
    const collection = localCollections.find((item) => item.id === id);
    if (collection) {
      collection.name = name;
      collection.updatedAt = now;
      return collection;
    }
    return { id, name, createdAt: now, updatedAt: now, requestCount: 0 };
  }

  return invoke<Collection>("rename_collection", { id, name });
}

export async function deleteCollection(id: string): Promise<void> {
  if (!isTauri) {
    const childIds = collectLocalCollectionIds(id);
    for (const childId of childIds) {
      const collectionIndex = localCollections.findIndex((collection) => collection.id === childId);
      if (collectionIndex >= 0) localCollections.splice(collectionIndex, 1);
    }
    for (let index = localSavedRequests.length - 1; index >= 0; index -= 1) {
      const collectionId = localSavedRequests[index].collectionId;
      if (collectionId && childIds.includes(collectionId)) {
        localSavedRequests.splice(index, 1);
      }
    }
    return;
  }
  return invoke<void>("delete_collection", { id });
}

export async function moveCollection(id: string, parentId?: string): Promise<void> {
  if (!isTauri) {
    const collection = localCollections.find((item) => item.id === id);
    if (collection) collection.parentId = parentId;
    return;
  }
  return invoke<void>("move_collection", { id, parentId: parentId ?? null });
}

export async function moveRequest(id: string, collectionId?: string): Promise<void> {
  if (!isTauri) {
    const request = localSavedRequests.find((item) => item.id === id);
    if (request) request.collectionId = collectionId;
    return;
  }
  return invoke<void>("move_request", { id, collectionId: collectionId ?? null });
}

export async function deleteRequest(id: string): Promise<void> {
  if (!isTauri) {
    const index = localSavedRequests.findIndex((request) => request.id === id);
    if (index >= 0) {
      localSavedRequests.splice(index, 1);
    }
    return;
  }

  return invoke<void>("delete_request", { id });
}

export async function saveRequest(request: RequestDraft): Promise<SavedRequest> {
  if (!isTauri) {
    const now = new Date().toISOString();
    const saved = {
      ...request,
      id: request.id ?? crypto.randomUUID(),
      collectionId: request.collectionId,
      createdAt: now,
      updatedAt: now,
    };
    const index = localSavedRequests.findIndex((item) => item.id === saved.id);
    if (index >= 0) {
      localSavedRequests[index] = saved;
    } else {
      localSavedRequests.unshift(saved);
    }
    return saved;
  }

  return invoke<SavedRequest>("save_request", { request });
}

export async function listRequests(collectionId?: string): Promise<SavedRequest[]> {
  if (!isTauri) {
    return localSavedRequests.filter((request) => request.collectionId === collectionId);
  }

  return invoke<SavedRequest[]>("list_requests", { collectionId: collectionId ?? null });
}

export async function exportCollection(id: string): Promise<unknown> {
  if (!isTauri) throw new Error("浏览器预览暂不支持导出集合");
  return invoke<unknown>("export_collection", { id });
}

export async function importCollection(payload: unknown, parentId?: string): Promise<Collection> {
  if (!isTauri) throw new Error("浏览器预览暂不支持导入集合");
  return invoke<Collection>("import_collection", { payload, parentId: parentId ?? null });
}

export async function exportRequest(id: string): Promise<unknown> {
  if (!isTauri) throw new Error("浏览器预览暂不支持导出 API");
  return invoke<unknown>("export_request", { id });
}

export async function importRequest(payload: unknown, collectionId?: string): Promise<SavedRequest> {
  if (!isTauri) throw new Error("浏览器预览暂不支持导入 API");
  return invoke<SavedRequest>("import_request", { payload, collectionId: collectionId ?? null });
}

export async function listHistory(): Promise<HistoryEntry[]> {
  if (!isTauri) return [];
  return invoke<HistoryEntry[]>("list_history");
}

export async function saveHistoryEntry(entry: HistoryEntry): Promise<HistoryEntry> {
  if (!isTauri) return entry;
  return invoke<HistoryEntry>("save_history_entry", { entry });
}

export async function listLogs(limit = 300): Promise<LogEntry[]> {
  if (!isTauri) return localLogs.slice(0, limit);
  return invoke<LogEntry[]>("list_logs", { limit });
}

export async function saveLog(entry: LogEntry): Promise<LogEntry> {
  if (!isTauri) {
    localLogs.unshift(entry);
    return entry;
  }
  return invoke<LogEntry>("save_log", { entry });
}

export async function clearLogs(): Promise<void> {
  if (!isTauri) {
    localLogs.splice(0, localLogs.length);
    return;
  }
  return invoke<void>("clear_logs");
}

export async function listEnvironments(): Promise<Environment[]> {
  if (!isTauri) {
    const now = new Date().toISOString();
    if (!localEnvironmentsInitialized) {
      localEnvironmentsInitialized = true;
      localEnvironments.push({
        id: "dev",
        name: "开发环境",
        createdAt: now,
        updatedAt: now,
        variables: [
          {
            id: "base-url",
            key: "base_url",
            value: "https://httpbin.org",
            enabled: true,
            secret: false,
          },
        ],
      });
    }
    return localEnvironments;
  }

  return invoke<Environment[]>("list_environments");
}

export async function saveEnvironment(environment: Environment): Promise<Environment> {
  if (!isTauri) {
    const now = new Date().toISOString();
    const saved = {
      ...environment,
      id: environment.id || crypto.randomUUID(),
      createdAt: environment.createdAt || now,
      updatedAt: now,
    };
    const index = localEnvironments.findIndex((item) => item.id === saved.id);
    if (index >= 0) {
      localEnvironments[index] = saved;
    } else {
      localEnvironments.push(saved);
    }
    return saved;
  }
  return invoke<Environment>("save_environment", { environment });
}

export async function deleteEnvironment(id: string): Promise<void> {
  if (!isTauri) {
    const index = localEnvironments.findIndex((environment) => environment.id === id);
    if (index >= 0) localEnvironments.splice(index, 1);
    return;
  }
  return invoke<void>("delete_environment", { id });
}

function collectLocalCollectionIds(rootId: string): string[] {
  const ids = [rootId];
  for (let index = 0; index < ids.length; index += 1) {
    for (const collection of localCollections.filter((item) => item.parentId === ids[index])) {
      ids.push(collection.id);
    }
  }
  return ids;
}

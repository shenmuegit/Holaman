import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import Editor from "@monaco-editor/react";
import {
  Archive,
  BookOpen,
  Braces,
  ChevronDown,
  Clock3,
  Code2,
  Copy,
  Database,
  Download,
  FileJson2,
  Folder,
  Globe2,
  History,
  Clipboard,
  Pencil,
  Plus,
  Search,
  Send,
  Settings,
  SquareTerminal,
  Trash2,
  Upload,
  Variable,
  X,
} from "lucide-react";
import {
  clearLogs,
  deleteCollection,
  deleteEnvironment,
  deleteRequest,
  exportCollection,
  exportRequest,
  importCollection,
  importRequest,
  listCollections,
  listEnvironments,
  listHistory,
  listLogs,
  listRequests,
  moveCollection,
  moveRequest,
  renameCollection,
  saveHistoryEntry,
  saveLog,
  saveCollection,
  saveEnvironment,
  saveRequest,
  sendHttpRequest,
} from "./lib/api";
import { draftToCurl, parseCurl } from "./lib/curl";
import { formatBytes, formatHtmlPretty, looksLikeHtml, rowId, tryFormatJson } from "./lib/format";
import type {
  BodyMode,
  Collection,
  Environment,
  HistoryEntry,
  HttpMethod,
  HttpRequestPayload,
  HttpResponsePayload,
  KeyValueRow,
  LogEntry,
  LogLevel,
  LogStage,
  MockConfig,
  RequestDraft,
  ScriptConfig,
  SavedRequest,
  Variable as EnvironmentVariable,
} from "./types";

type ResponseCookie = {
  id: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
};

type WorkspaceRequestTab = {
  id: string;
  persistedRequestId?: string;
  draft: RequestDraft;
  response: HttpResponsePayload | null;
  error: string | null;
  requestTab: string;
  responseTab: string;
  scriptTab: string;
  scriptLogs: ScriptLogEntry[];
  dirty: boolean;
};

type ScriptLogLevel = "log" | "warn" | "error" | "pass" | "fail";

type ScriptLogEntry = {
  id: string;
  time: string;
  level: ScriptLogLevel;
  message: string;
};

type PersistedAppState = {
  version: 1;
  activeModule: string;
  leftTab: string;
  rightTab: string;
  workspaceTabs: WorkspaceRequestTab[];
  activeWorkspaceTabId: string;
  expandedCollectionId: string | null;
  expandedCollectionIds: string[];
  leftWidth: number;
  rightWidth: number;
  requestHeight: number;
};

type ContextMenuTarget =
  | { type: "collection"; collection: Collection }
  | { type: "request"; request: SavedRequest }
  | { type: "environment"; environment: Environment }
  | { type: "environment-root" }
  | { type: "root" };

type ContextMenuState = {
  x: number;
  y: number;
  target: ContextMenuTarget;
};

type DragPayload =
  | { type: "collection"; id: string }
  | { type: "request"; id: string };

type CollectionTreeNode = {
  collection: Collection;
  children: CollectionTreeNode[];
  requests: SavedRequest[];
};

type DropTargetState = { id: string; target: "root" | "collection" } | null;

type TreeDragState = {
  payload: DragPayload;
  label: string;
  x: number;
  y: number;
} | null;

type AppDialog =
  | {
      type: "text";
      title: string;
      message?: string;
      initialValue: string;
      placeholder?: string;
      confirmText: string;
      cancelText: string;
      resolve: (value: string | null) => void;
    }
  | {
      type: "confirm";
      title: string;
      message: string;
      detail?: string;
      confirmText: string;
      cancelText: string;
      danger?: boolean;
      resolve: (value: boolean) => void;
    }
  | {
      type: "textarea";
      title: string;
      message?: string;
      initialValue: string;
      placeholder?: string;
      confirmText: string;
      cancelText: string;
      readOnly?: boolean;
      resolve: (value: string | null) => void;
    };

const methods: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const requestTabs = ["Params", "Headers", "Body", "Mock", "Scripts", "Docs"];
const responseTabs = ["Body", "Headers", "Raw", "Cookies", "Tests", "Timeline"];
const rightTabs = ["Variables", "Logs"];
const autoSaveIntervalOptions = [3000, 5000, 10000, 30000];
const autoSaveIntervalStorageKey = "holaman.autoSaveIntervalMs";
const appStateStorageKey = "holaman.appState.v1";
const rootRequestKey = "__holaman_root_requests__";
const responseTabLabels: Record<string, string> = {
  Body: "响应体",
  Headers: "响应头",
  Raw: "原始",
  Cookies: "Cookie",
  Tests: "测试",
  Timeline: "时间线",
};

const zh: Record<string, string> = {
  Workspace: "工作台",
  Collections: "集合",
  Environments: "环境",
  Mock: "Mock",
  Guide: "使用文档",
  Settings: "设置",
  Params: "参数",
  Headers: "请求头",
  Body: "请求体",
  Auth: "鉴权",
  Cookies: "Cookie",
  Scripts: "脚本",
  Tests: "测试",
  Docs: "文档",
  Raw: "原始",
  Timeline: "时间线",
  Variables: "变量",
  Logs: "日志",
  pre: "请求前",
  post: "响应后",
  logs: "日志",
  Status: "状态",
  Time: "耗时",
  Size: "大小",
  URL: "URL",
};

const t = (key: string) => zh[key] ?? key;

const emptyRow = (prefix: string): KeyValueRow => ({
  id: rowId(prefix),
  enabled: true,
  key: "",
  value: "",
  description: "",
});

const createDefaultMockConfig = (): MockConfig => ({
  enabled: false,
  statusCode: 200,
  delayMs: 0,
  headers: [
    { id: rowId("mock-header"), enabled: true, key: "Content-Type", value: "application/json", description: "" },
  ],
  body: '{\n  "message": "Hello from Holaman Mock"\n}',
});

const createDefaultScriptConfig = (): ScriptConfig => ({
  enabled: false,
  preRequest: "// 请求发送前执行\n// request.headers.set(\"X-Request-Id\", uuid())\n",
  postResponse:
    "// 响应返回后执行\n// const data = response.json()\n// env.set(\"token\", data.access_token)\n// expect(response.status).toBe(200)\n",
});

const initialDraft: RequestDraft = {
  name: "未命名请求",
  method: "GET",
  url: "https://httpbin.org/get",
  params: [emptyRow("param")],
  headers: [emptyRow("header")],
  bodyMode: "json",
  body: "{\n  \"hello\": \"Holaman\"\n}",
  timeoutMs: 30000,
  environmentId: "dev",
  mockConfig: createDefaultMockConfig(),
  scripts: createDefaultScriptConfig(),
};

const initialWorkspaceTabId = "request-tab-initial";

function createEmptyRequestDraft(collectionId?: string, environmentId = "dev"): RequestDraft {
  return {
    name: "未命名请求",
    method: "GET",
    url: "",
    params: [emptyRow("param")],
    headers: [emptyRow("header")],
    bodyMode: "none",
    body: "",
    timeoutMs: 30000,
    collectionId,
    environmentId,
    mockConfig: createDefaultMockConfig(),
    scripts: createDefaultScriptConfig(),
  };
}

function createWorkspaceRequestTab(
  draft: RequestDraft,
  id = rowId("request-tab"),
  dirty = false,
): WorkspaceRequestTab {
  return {
    id,
    persistedRequestId: draft.id,
    draft,
    response: null,
    error: null,
    requestTab: "Params",
    responseTab: "Body",
    scriptTab: "pre",
    scriptLogs: [],
    dirty,
  };
}

function App() {
  const persistedAppState = useMemo(readPersistedAppState, []);
  const [activeModule, setActiveModule] = useState(persistedAppState?.activeModule ?? "Workspace");
  const [leftTab, setLeftTab] = useState(persistedAppState?.leftTab ?? "Collections");
  const [rightTab, setRightTab] = useState(persistedAppState?.rightTab ?? "Variables");
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceRequestTab[]>(() =>
    persistedAppState?.workspaceTabs.length
      ? persistedAppState.workspaceTabs
      : [createWorkspaceRequestTab(initialDraft, initialWorkspaceTabId)],
  );
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState(
    persistedAppState?.activeWorkspaceTabId ?? initialWorkspaceTabId,
  );
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionRequests, setCollectionRequests] = useState<Record<string, SavedRequest[]>>({});
  const [expandedCollectionId, setExpandedCollectionId] = useState<string | null>(
    persistedAppState?.expandedCollectionId ?? null,
  );
  const [expandedCollectionIds, setExpandedCollectionIds] = useState<string[]>(
    persistedAppState?.expandedCollectionIds ??
      (persistedAppState?.expandedCollectionId ? [persistedAppState.expandedCollectionId] : []),
  );
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState("all");
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState>(null);
  const [treeDrag, setTreeDrag] = useState<TreeDragState>(null);
  const [leftWidth, setLeftWidth] = useState(persistedAppState?.leftWidth ?? 280);
  const [rightWidth, setRightWidth] = useState(persistedAppState?.rightWidth ?? 320);
  const [requestHeight, setRequestHeight] = useState(persistedAppState?.requestHeight ?? 420);
  const [autoSaveIntervalMs, setAutoSaveIntervalMs] = useState(readAutoSaveIntervalMs);
  const [isAutoSaving, setIsAutoSaving] = useState(false);
  const workspaceTabsRef = useRef(workspaceTabs);
  const autoSaveInFlightRef = useRef(false);

  const loadCollectionsAndRequests = async () => {
    const nextCollections = await listCollections();
    const requestEntries = await Promise.all([
      listRequests().then((requests) => [rootRequestKey, requests] as const),
      ...nextCollections.map((collection) =>
        listRequests(collection.id).then((requests) => [collection.id, requests] as const),
      ),
    ]);

    return {
      nextCollections,
      nextCollectionRequests: Object.fromEntries(requestEntries) as Record<string, SavedRequest[]>,
    };
  };

  const refreshCollectionsAndRequests = async () => {
    const { nextCollections, nextCollectionRequests } = await loadCollectionsAndRequests();
    setCollections(nextCollections);
    setCollectionRequests(nextCollectionRequests);
    return { nextCollections, nextCollectionRequests };
  };

  const refreshLogs = async () => {
    const nextLogs = await listLogs();
    setLogs(nextLogs);
    return nextLogs;
  };

  const appendAppLog = async (entry: Omit<LogEntry, "id" | "createdAt">) => {
    const nextEntry: LogEntry = {
      id: rowId("app-log"),
      createdAt: new Date().toISOString(),
      ...entry,
    };
    setLogs((items) => [...items, nextEntry].slice(-300));
    try {
      const savedEntry = await saveLog(nextEntry);
      setLogs((items) => [...items.filter((item) => item.id !== nextEntry.id), savedEntry].slice(-300));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "日志保存失败");
    }
  };

  const clearPersistedLogs = async () => {
    await clearLogs();
    setLogs([]);
    setNotice("日志已清空");
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [{ nextCollections, nextCollectionRequests }, nextHistory, nextEnvironments, nextLogs] = await Promise.all([
        loadCollectionsAndRequests(),
        listHistory(),
        listEnvironments(),
        listLogs(),
      ]);

      if (cancelled) {
        return;
      }

      setCollections(nextCollections);
      setCollectionRequests(nextCollectionRequests);
      setHistory(nextHistory);
      setEnvironments(nextEnvironments);
      setLogs(nextLogs);

      const restoredCollectionId = nextCollections.some(
        (collection) => collection.id === persistedAppState?.expandedCollectionId,
      )
        ? persistedAppState?.expandedCollectionId ?? null
        : null;
      const startupCollectionId = restoredCollectionId ?? nextCollections[0]?.id ?? null;

      if (startupCollectionId) {
        setExpandedCollectionId(startupCollectionId);
        setExpandedCollectionIds((items) => Array.from(new Set([...items, startupCollectionId])));
      }
      const requests = startupCollectionId
        ? nextCollectionRequests[collectionRequestKey(startupCollectionId)] ?? []
        : nextCollectionRequests[rootRequestKey] ?? [];

      if (!persistedAppState?.workspaceTabs.length && requests[0]) {
        const startupTab = createWorkspaceRequestTab(requests[0], initialWorkspaceTabId);
        setWorkspaceTabs([startupTab]);
        setActiveWorkspaceTabId(startupTab.id);
      }
    })().catch((caught) => {
      setNotice(caught instanceof Error ? caught.message : "启动状态恢复失败");
    });

    return () => {
      cancelled = true;
    };
  }, [persistedAppState]);

  const activeWorkspaceTab =
    workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ??
    workspaceTabs[0] ??
    createWorkspaceRequestTab(initialDraft, initialWorkspaceTabId);
  const draft = activeWorkspaceTab.draft;
  const response = activeWorkspaceTab.response;
  const error = activeWorkspaceTab.error;
  const requestTab = activeWorkspaceTab.requestTab;
  const responseTab = activeWorkspaceTab.responseTab;
  const scriptTab = activeWorkspaceTab.scriptTab;
  const scriptLogs = activeWorkspaceTab.scriptLogs;

  const updateWorkspaceTab = (tabId: string, updater: (tab: WorkspaceRequestTab) => WorkspaceRequestTab) => {
    setWorkspaceTabs((items) => items.map((item) => (item.id === tabId ? updater(item) : item)));
  };

  const updateActiveWorkspaceTab = (updater: (tab: WorkspaceRequestTab) => WorkspaceRequestTab) => {
    updateWorkspaceTab(activeWorkspaceTabId, updater);
  };

  const setDraft = (value: SetStateAction<RequestDraft>) => {
    updateActiveWorkspaceTab((tab) => ({
      ...tab,
      draft: preserveRequestIdentity(
        typeof value === "function" ? (value as (current: RequestDraft) => RequestDraft)(tab.draft) : value,
        tab,
      ),
      dirty: true,
    }));
  };

  const setRequestTab = (value: string) => {
    updateActiveWorkspaceTab((tab) => ({ ...tab, requestTab: value }));
  };

  const setResponseTab = (value: string) => {
    updateActiveWorkspaceTab((tab) => ({ ...tab, responseTab: value }));
  };

  const setScriptTab = (value: string) => {
    updateActiveWorkspaceTab((tab) => ({ ...tab, scriptTab: value }));
  };

  const appendWorkspaceTab = (nextDraft: RequestDraft, noticeMessage: string, dirty = false) => {
    const nextTab = createWorkspaceRequestTab(nextDraft, rowId("request-tab"), dirty);
    setWorkspaceTabs((items) => [...items, nextTab]);
    setActiveWorkspaceTabId(nextTab.id);
    setNotice(noticeMessage);
  };

  const openRequestDraft = (nextDraft: RequestDraft, noticeMessage: string) => {
    const existingTab = nextDraft.id
      ? workspaceTabs.find((tab) => tab.persistedRequestId === nextDraft.id || tab.draft.id === nextDraft.id)
      : undefined;

    if (existingTab) {
      setActiveWorkspaceTabId(existingTab.id);
      setNotice(noticeMessage);
      return;
    }

    appendWorkspaceTab(nextDraft, noticeMessage);
  };

  const closeWorkspaceTabs = (shouldClose: (tab: WorkspaceRequestTab) => boolean) => {
    const closingIndex = workspaceTabs.findIndex(shouldClose);
    if (closingIndex < 0) {
      return;
    }

    const nextTabs = workspaceTabs.filter((tab) => !shouldClose(tab));
    if (nextTabs.length === 0) {
      const fallbackTab = createWorkspaceRequestTab(
        createEmptyRequestDraft(expandedCollectionId ?? draft.collectionId, draft.environmentId),
        rowId("request-tab"),
      );
      setWorkspaceTabs([fallbackTab]);
      setActiveWorkspaceTabId(fallbackTab.id);
      return;
    }

    setWorkspaceTabs(nextTabs);

    if (!nextTabs.some((tab) => tab.id === activeWorkspaceTabId)) {
      const nextActiveTab = nextTabs[Math.min(closingIndex, nextTabs.length - 1)] ?? nextTabs[0];
      setActiveWorkspaceTabId(nextActiveTab.id);
    }
  };

  const closeWorkspaceTab = (tabId: string) => {
    closeWorkspaceTabs((tab) => tab.id === tabId);
  };

  const closeWorkspaceTabsLeft = (tabId: string) => {
    const targetIndex = workspaceTabs.findIndex((tab) => tab.id === tabId);
    if (targetIndex <= 0) return;
    const closingIds = new Set(workspaceTabs.slice(0, targetIndex).map((tab) => tab.id));
    closeWorkspaceTabs((tab) => closingIds.has(tab.id));
  };

  const closeWorkspaceTabsRight = (tabId: string) => {
    const targetIndex = workspaceTabs.findIndex((tab) => tab.id === tabId);
    if (targetIndex < 0 || targetIndex >= workspaceTabs.length - 1) return;
    const closingIds = new Set(workspaceTabs.slice(targetIndex + 1).map((tab) => tab.id));
    closeWorkspaceTabs((tab) => closingIds.has(tab.id));
  };

  const closeAllWorkspaceTabs = () => {
    closeWorkspaceTabs(() => true);
  };

  const closeWorkspaceTabsByRequestId = (requestId: string) => {
    closeWorkspaceTabs((tab) => tab.persistedRequestId === requestId || tab.draft.id === requestId);
  };

  const registerSavedRequest = async (
    saved: SavedRequest,
    options: { expandCollection?: boolean; shouldInsert?: boolean } = {},
  ) => {
    const { expandCollection = false, shouldInsert = false } = options;

    setCollectionRequests((items) => {
      const requestKey = collectionRequestKey(saved.collectionId);
      const currentRequests = items[requestKey];
      if (!currentRequests) {
        return shouldInsert ? { ...items, [requestKey]: [saved] } : items;
      }

      const existingIndex = currentRequests.findIndex((request) => request.id === saved.id);
      if (existingIndex < 0) {
        return shouldInsert
          ? { ...items, [requestKey]: [saved, ...currentRequests] }
          : items;
      }

      return {
        ...items,
        [requestKey]: currentRequests.map((request) =>
          request.id === saved.id ? { ...request, ...saved } : request,
        ),
      };
    });

    if (expandCollection && saved.collectionId) {
      setExpandedCollectionId(saved.collectionId);
      setExpandedCollectionIds((items) => Array.from(new Set([...items, saved.collectionId!])));
    }

    const nextCollections = await listCollections();
    if (nextCollections.length > 0) {
      setCollections(nextCollections);
      return;
    }

    const now = new Date().toISOString();
    setCollections((items) => {
      const exists = items.some((collection) => collection.id === saved.collectionId);
      if (saved.collectionId && !exists) {
        return [
          { id: saved.collectionId, name: "本地集合", createdAt: now, updatedAt: now, requestCount: 1 },
          ...items,
        ];
      }

      return items.map((collection) =>
        collection.id === saved.collectionId
          ? { ...collection, requestCount: Math.max(collection.requestCount, 1), updatedAt: now }
          : collection,
      );
    });
  };

  const persistRequestTab = async (tab: WorkspaceRequestTab, expandCollection = false) => {
    const requestId = tab.persistedRequestId ?? tab.draft.id;
    const isNewRequest = !requestId;
    const draftSnapshot = requestId ? { ...tab.draft, id: requestId } : tab.draft;
    const snapshotSignature = requestDraftSignature(draftSnapshot);
    const saved = await saveRequest(draftSnapshot);

    setWorkspaceTabs((items) =>
      items.map((item) => {
        if (item.id !== tab.id) {
          return item;
        }

        const currentDraft = preserveRequestIdentity(item.draft, {
          ...item,
          persistedRequestId: item.persistedRequestId ?? saved.id,
        });

        if (requestDraftSignature(currentDraft) === snapshotSignature) {
          return { ...item, persistedRequestId: saved.id, draft: saved, dirty: false };
        }

        return {
          ...item,
          persistedRequestId: saved.id,
          draft: {
            ...currentDraft,
            id: currentDraft.id ?? saved.id,
            collectionId: currentDraft.collectionId ?? saved.collectionId,
          },
          dirty: true,
        };
      }),
    );

    await registerSavedRequest(saved, { expandCollection, shouldInsert: isNewRequest });
    return saved;
  };

  useEffect(() => {
    workspaceTabsRef.current = workspaceTabs;
    setCollectionRequests((items) => syncCollectionRequestsFromTabs(items, workspaceTabs));
  }, [workspaceTabs]);

  useEffect(() => {
    writePersistedAppState({
      version: 1,
      activeModule,
      leftTab,
      rightTab,
      workspaceTabs,
      activeWorkspaceTabId,
      expandedCollectionId,
      expandedCollectionIds,
      leftWidth,
      rightWidth,
      requestHeight,
    });
  }, [
    activeModule,
    leftTab,
    rightTab,
    workspaceTabs,
    activeWorkspaceTabId,
    expandedCollectionId,
    expandedCollectionIds,
    leftWidth,
    rightWidth,
    requestHeight,
  ]);

  useEffect(() => {
    try {
      localStorage.setItem(autoSaveIntervalStorageKey, String(autoSaveIntervalMs));
    } catch {
      // Ignore storage failures in restricted WebView contexts.
    }
  }, [autoSaveIntervalMs]);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (autoSaveInFlightRef.current) {
        return;
      }

      const dirtyTabs = workspaceTabsRef.current.filter(
        (tab) => tab.dirty && isPersistableDraft(tab.draft),
      );
      if (dirtyTabs.length === 0) {
        return;
      }

      autoSaveInFlightRef.current = true;
      setIsAutoSaving(true);
      void Promise.all(dirtyTabs.map((tab) => persistRequestTab(tab)))
        .then(() => {
          setNotice("已自动保存");
        })
        .catch((caught) => {
          setNotice(caught instanceof Error ? caught.message : "自动保存失败");
        })
        .finally(() => {
          autoSaveInFlightRef.current = false;
          setIsAutoSaving(false);
        });
    }, autoSaveIntervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [autoSaveIntervalMs]);

  const currentEnvironment = useMemo(
    () => environments.find((environment) => environment.id === draft.environmentId) ?? environments[0],
    [draft.environmentId, environments],
  );

  useEffect(() => {
    if (environments.length === 0 || draft.environmentId === currentEnvironment?.id) {
      return;
    }
    if (currentEnvironment?.id) {
      selectEnvironment(currentEnvironment.id);
    }
  }, [currentEnvironment?.id, draft.environmentId, environments.length]);

  const selectEnvironment = (environmentId: string) => {
    const environment = environments.find((item) => item.id === environmentId);
    setWorkspaceTabs((items) =>
      items.map((tab) => ({
        ...tab,
        draft: { ...tab.draft, environmentId },
        dirty: tab.dirty || isPersistableDraft(tab.draft),
      })),
    );
    setNotice(environment ? `已切换环境：${environment.name}` : "已切换环境");
  };

  const clearEnvironmentSelection = () => {
    setWorkspaceTabs((items) =>
      items.map((tab) => ({
        ...tab,
        draft: { ...tab.draft, environmentId: undefined },
        dirty: tab.dirty || isPersistableDraft(tab.draft),
      })),
    );
  };

  const persistEnvironment = async (environment: Environment, noticeMessage: string) => {
    const saved = await saveEnvironment(environment);
    const nextEnvironments = await listEnvironments();
    setEnvironments(nextEnvironments);
    selectEnvironment(saved.id);
    setLeftTab("Environments");
    setNotice(noticeMessage);
    return saved;
  };

  const renameEnvironment = async (environment: Environment, name: string) => {
    const nextName = name.trim();
    if (!nextName || nextName === environment.name) return;
    const now = new Date().toISOString();
    await persistEnvironment({
      ...environment,
      name: nextName,
      updatedAt: now,
    }, `已重命名环境：${nextName}`);
  };

  const saveEnvironmentVariablesFromText = async (environment: Environment, text: string) => {
    const variables = parseEnvironmentVariablesText(text);
    const now = new Date().toISOString();
    await persistEnvironment({
      ...environment,
      variables,
      updatedAt: now,
    }, `已更新环境变量：${environment.name}`);
  };

  const createEnvironment = async () => {
    const name = await askText({
      title: "创建环境",
      message: "请输入环境名称。变量可以创建后在右键菜单中编辑。",
      initialValue: "新环境",
      placeholder: "开发环境",
      confirmText: "创建",
      cancelText: "取消",
    });
    const trimmedName = name?.trim();
    if (!trimmedName) return;

    const now = new Date().toISOString();
    await persistEnvironment({
      id: crypto.randomUUID(),
      name: trimmedName,
      variables: [],
      createdAt: now,
      updatedAt: now,
    }, `已创建环境：${trimmedName}`);
  };

  const editEnvironment = async (environment: Environment) => {
    const text = await askTextarea({
      title: "编辑环境变量",
      message: "每行一个变量，例如 base_url=http://localhost:3000。环境名称请直接在左侧列表中编辑。",
      initialValue: serializeEnvironmentVariablesText(environment),
      placeholder: "base_url=http://localhost:3000\ntoken=dev-token",
      confirmText: "保存",
      cancelText: "取消",
    });
    if (text) {
      await saveEnvironmentVariablesFromText(environment, text);
    }
  };

  const deleteExistingEnvironment = async (environment: Environment) => {
    const confirmed = await askConfirm({
      title: "删除环境",
      message: `确认删除环境「${environment.name}」？`,
      detail: "使用此环境的请求会在下次发送前自动回落到可用环境。",
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });

    if (!confirmed) return;

    await deleteEnvironment(environment.id);
    const nextEnvironments = await listEnvironments();
    setEnvironments(nextEnvironments);
    const fallbackId = nextEnvironments[0]?.id;
    if (draft.environmentId === environment.id && fallbackId) {
      selectEnvironment(fallbackId);
    } else if (draft.environmentId === environment.id) {
      clearEnvironmentSelection();
    }
    setNotice(`已删除环境：${environment.name}`);
  };

  const payload = useMemo(
    () => draftToPayload(draft, currentEnvironment?.id),
    [currentEnvironment?.id, draft],
  );

  const sendRequest = async () => {
    const targetTabId = activeWorkspaceTab.id;
    const requestDraft = draft;
    let requestToSend = requestDraft;
    let requestPayload = payload;

    setIsSending(true);
    updateWorkspaceTab(targetTabId, (tab) => ({ ...tab, error: null, scriptLogs: [] }));
    setNotice(null);

    try {
      const preResult = await runScriptStage({
        stage: "pre",
        draft: requestDraft,
        response: null,
        environment: currentEnvironment,
      });
      requestToSend = preResult.draft;
      requestPayload = draftToPayload(requestToSend, currentEnvironment?.id);
      updateWorkspaceTab(targetTabId, (tab) => ({ ...tab, scriptLogs: preResult.logs }));
      await persistScriptLogs(preResult.logs, "pre-script", requestToSend, appendAppLog);

      if (preResult.failed) {
        throw new Error("请求前脚本执行失败");
      }

      await appendAppLog({
        requestId: requestToSend.id,
        requestName: requestDisplayName(requestToSend),
        method: requestToSend.method,
        url: requestToSend.url,
        level: "info",
        stage: "request",
        message: `开始请求 ${requestToSend.method} ${requestToSend.url || "未填写 URL"}`,
        requestBody: formatRequestLogSnapshot(requestToSend),
      });

      const nextResponse = requestToSend.mockConfig?.enabled
        ? await createMockResponse(requestToSend)
        : await sendHttpRequest(requestPayload);
      if (requestToSend.mockConfig?.enabled) {
        await appendAppLog({
          requestId: requestToSend.id,
          requestName: requestDisplayName(requestToSend),
          method: requestToSend.method,
          url: nextResponse.url,
          status: nextResponse.status,
          durationMs: nextResponse.durationMs,
          sizeBytes: nextResponse.sizeBytes,
          level: nextResponse.status >= 400 ? "warn" : "success",
          stage: "mock",
          message: `Mock 响应 ${nextResponse.status} ${nextResponse.statusText}`,
          requestBody: formatRequestLogSnapshot(requestToSend),
          responseBody: nextResponse.body,
        });
      }
      await appendAppLog({
        requestId: requestToSend.id,
        requestName: requestDisplayName(requestToSend),
        method: requestToSend.method,
        url: nextResponse.url,
        status: nextResponse.status,
        durationMs: nextResponse.durationMs,
        sizeBytes: nextResponse.sizeBytes,
        level: nextResponse.status >= 400 ? "warn" : "success",
        stage: "response",
        message: `响应 ${nextResponse.status} ${nextResponse.statusText}，耗时 ${nextResponse.durationMs} ms`,
        requestBody: formatRequestLogSnapshot(requestToSend),
        responseBody: nextResponse.body,
      });
      const postResult = await runScriptStage({
        stage: "post",
        draft: requestToSend,
        response: nextResponse,
        environment: currentEnvironment,
      });
      await persistScriptLogs(postResult.logs, "post-script", requestToSend, appendAppLog, nextResponse);
      if (postResult.environment) {
        const savedEnvironment = await saveEnvironment(postResult.environment);
        setEnvironments((items) =>
          items.map((item) => (item.id === savedEnvironment.id ? savedEnvironment : item)),
        );
      }
      updateWorkspaceTab(targetTabId, (tab) => ({
        ...tab,
        response: nextResponse,
        responseTab: "Body",
        scriptLogs: [...tab.scriptLogs, ...postResult.logs],
      }));

      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        method: requestToSend.method,
        url: requestToSend.url,
        status: nextResponse.status,
        durationMs: nextResponse.durationMs,
        createdAt: new Date().toISOString(),
        draft: requestToSend,
      };
      const savedEntry = await saveHistoryEntry(entry);
      setHistory((items) => [savedEntry, ...items.filter((item) => item.id !== savedEntry.id)].slice(0, 80));
    } catch (caught) {
      await appendAppLog({
        requestId: requestToSend.id,
        requestName: requestDisplayName(requestToSend),
        method: requestToSend.method,
        url: requestToSend.url,
        level: "error",
        stage: "error",
        message: caught instanceof Error ? caught.message : String(caught),
        requestBody: formatRequestLogSnapshot(requestToSend),
      });
      updateWorkspaceTab(targetTabId, (tab) => ({
        ...tab,
        error: caught instanceof Error ? caught.message : String(caught),
      }));
    } finally {
      setIsSending(false);
    }
  };

  const createCollection = async (name: string, parentId?: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    const collection = await saveCollection(trimmedName, parentId);
    await refreshCollectionsAndRequests();
    setExpandedCollectionId(collection.id);
    setExpandedCollectionIds((items) => Array.from(new Set([...items, collection.id])));
    if (!draft.id) {
      setDraft((current) => ({ ...current, collectionId: collection.id }));
    }
    setLeftTab("Collections");
    setNotice(`已创建集合：${collection.name}`);
  };

  const askText = (options: Omit<Extract<AppDialog, { type: "text" }>, "type" | "resolve">) =>
    new Promise<string | null>((resolve) => {
      setDialog({ type: "text", ...options, resolve });
    });

  const askConfirm = (options: Omit<Extract<AppDialog, { type: "confirm" }>, "type" | "resolve">) =>
    new Promise<boolean>((resolve) => {
      setDialog({ type: "confirm", ...options, resolve });
    });

  const askTextarea = (options: Omit<Extract<AppDialog, { type: "textarea" }>, "type" | "resolve">) =>
    new Promise<string | null>((resolve) => {
      setDialog({ type: "textarea", ...options, resolve });
    });

  const renameExistingCollection = async (collection: Collection) => {
    const name = (
      await askText({
        title: "重命名集合",
        message: "请输入新的集合名称。",
        initialValue: collection.name,
        placeholder: "集合名称",
        confirmText: "保存",
        cancelText: "取消",
      })
    )?.trim();

    if (!name) {
      return;
    }

    if (name === collection.name) {
      return;
    }

    const renamed = await renameCollection(collection.id, name);
    setCollections((items) =>
      items.map((item) =>
        item.id === collection.id
          ? { ...item, ...renamed, requestCount: item.requestCount }
          : item,
      ),
    );
    setNotice(`已重命名为：${renamed.name}`);
  };

  const selectCollection = (collection: Collection) => {
    setExpandedCollectionId(collection.id);
    setExpandedCollectionIds((items) =>
      items.includes(collection.id)
        ? items.filter((id) => id !== collection.id)
        : [...items, collection.id],
    );
    if (collection.requestCount > 0 && !collectionRequests[collection.id]) {
      void listRequests(collection.id).then((requests) => {
        setCollectionRequests((items) => ({ ...items, [collection.id]: requests }));
      });
    }
    setNotice(`已打开集合：${collection.name}`);
  };

  const selectSavedRequest = (request: SavedRequest) => {
    openRequestDraft(request, `已打开：${requestDisplayName(request)}`);
  };

  const deleteExistingCollection = async (collection: Collection) => {
    if (collection.requestCount > 0) {
      const firstConfirm = await askConfirm({
        title: "删除集合",
        message: `集合「${collection.name}」中包含 ${collection.requestCount} 个 API。`,
        detail: "删除集合会同时删除其中的请求。",
        confirmText: "继续",
        cancelText: "取消",
        danger: true,
      });
      if (!firstConfirm) return;

      const secondConfirm = await askConfirm({
        title: "再次确认删除",
        message: "此操作不可恢复。",
        detail: `确认删除集合「${collection.name}」及其中的 ${collection.requestCount} 个 API？`,
        confirmText: "确认删除",
        cancelText: "取消",
        danger: true,
      });
      if (!secondConfirm) return;
    }

    const deletedCollectionIds = collectionDescendantIds(collections, collection.id);
    await deleteCollection(collection.id);
    setCollections((items) => items.filter((item) => !deletedCollectionIds.includes(item.id)));
    setCollectionRequests((items) => {
      const next = { ...items };
      for (const collectionId of deletedCollectionIds) {
        delete next[collectionId];
      }
      return next;
    });
    setExpandedCollectionIds((items) => items.filter((id) => !deletedCollectionIds.includes(id)));
    setExpandedCollectionId((current) => (current && deletedCollectionIds.includes(current) ? null : current));
    closeWorkspaceTabs((tab) => Boolean(tab.draft.collectionId && deletedCollectionIds.includes(tab.draft.collectionId)));
    setNotice(`已删除集合：${collection.name}`);
  };

  const deleteExistingRequest = async (request: SavedRequest) => {
    const confirmed = await askConfirm({
      title: "删除 API",
      message: `确认删除「${requestDisplayName(request)}」？`,
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });

    if (!confirmed) {
      return;
    }

    await deleteRequest(request.id);
    const requestKey = collectionRequestKey(request.collectionId);
    setCollectionRequests((items) => ({
      ...items,
      [requestKey]: (items[requestKey] ?? []).filter((item) => item.id !== request.id),
    }));
    closeWorkspaceTabsByRequestId(request.id);

    const nextCollections = await listCollections();
    setCollections(nextCollections);
    setNotice(`已删除 API：${requestDisplayName(request)}`);
  };

  const createNewRequest = async (targetCollectionId?: string | null) => {
    const collectionId =
      targetCollectionId === null
        ? undefined
        : typeof targetCollectionId === "string"
          ? targetCollectionId
          : expandedCollectionId ?? draft.collectionId;
    const nextDraft: RequestDraft = {
      ...initialDraft,
      id: undefined,
      name: "未命名请求",
      url: "",
      params: [emptyRow("param")],
      headers: [emptyRow("header")],
      body: "",
      bodyMode: "none",
      collectionId,
      environmentId: draft.environmentId,
      mockConfig: createDefaultMockConfig(),
    };

    try {
      const saved = await saveRequest(nextDraft);
      await registerSavedRequest(saved, { expandCollection: true, shouldInsert: true });
      appendWorkspaceTab(saved, "已创建请求");
    } catch (caught) {
      appendWorkspaceTab(nextDraft, "已创建请求，等待自动保存", true);
      setNotice(caught instanceof Error ? caught.message : "创建请求暂未保存");
    }
  };

  const importCurl = async () => {
    const curl = await askTextarea({
      title: "导入 cURL",
      message: "粘贴 cURL 命令，Holaman 会解析 Method、URL、Header 和 Body。",
      initialValue: "",
      placeholder: "curl -X POST 'https://api.example.com/users' -H 'Content-Type: application/json' --data-raw '{...}'",
      confirmText: "导入",
      cancelText: "取消",
    });

    if (!curl?.trim()) {
      return;
    }

    try {
      const imported = parseCurl(curl, draft);
    appendWorkspaceTab(imported, "已导入 cURL", true);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "导入失败");
    }
  };

  const exportCurl = async () => {
    const curl = draftToCurl(draft);
    const result = await askTextarea({
      title: "导出 cURL",
      message: "当前请求已生成 cURL，可复制到终端或其他 API 工具中使用。",
      initialValue: curl,
      confirmText: "复制",
      cancelText: "关闭",
      readOnly: true,
    });

    if (result) {
      try {
        await navigator.clipboard?.writeText(result);
        setNotice("cURL 已复制");
      } catch {
        setNotice("无法自动复制，请手动复制弹窗内容");
      }
    }
  };

  const exportAllToDialog = async () => {
    const [{ nextCollections, nextCollectionRequests }, nextEnvironments] = await Promise.all([
      loadCollectionsAndRequests(),
      listEnvironments(),
    ]);
    const rootRequests = nextCollectionRequests[rootRequestKey] ?? [];
    const collectionRequestItems = nextCollections.flatMap(
      (collection) => nextCollectionRequests[collection.id] ?? [],
    );
    const payload = {
      type: "holaman.workspace",
      version: 1,
      exportedAt: new Date().toISOString(),
      collections: nextCollections,
      requests: [...rootRequests, ...collectionRequestItems],
      environments: nextEnvironments,
    };
    const text = JSON.stringify(payload, null, 2);
    const result = await askTextarea({
      title: "导出全部",
      message: "全部集合、顶层 API 和环境已导出为 Holaman JSON。",
      initialValue: text,
      confirmText: "复制",
      cancelText: "关闭",
      readOnly: true,
    });

    if (result) {
      await writeClipboardText(result);
      setNotice("全部数据 JSON 已复制");
    }
  };

  const closeContextMenu = () => setContextMenu(null);

  const openContextMenu = (event: ReactMouseEvent, target: ContextMenuTarget) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  };

  const writeClipboardText = async (text: string) => {
    await navigator.clipboard?.writeText(text);
  };

  const readClipboardText = async () => navigator.clipboard?.readText();

  const copyCollectionToClipboard = async (collection: Collection) => {
    const payload = await exportCollection(collection.id);
    await writeClipboardText(JSON.stringify(payload, null, 2));
    setNotice(`已复制集合：${collection.name}`);
  };

  const copyRequestToClipboard = async (request: SavedRequest) => {
    const payload = await exportRequest(request.id);
    await writeClipboardText(JSON.stringify(payload, null, 2));
    setNotice(`已复制 API：${requestDisplayName(request)}`);
  };

  const exportCollectionToDialog = async (collection: Collection) => {
    const payload = await exportCollection(collection.id);
    const text = JSON.stringify(payload, null, 2);
    const result = await askTextarea({
      title: "导出集合",
      message: "集合已导出为 Holaman JSON。",
      initialValue: text,
      confirmText: "复制",
      cancelText: "关闭",
      readOnly: true,
    });

    if (result) {
      await writeClipboardText(result);
      setNotice("集合 JSON 已复制");
    }
  };

  const exportRequestToDialog = async (request: SavedRequest) => {
    const payload = await exportRequest(request.id);
    const text = JSON.stringify(payload, null, 2);
    const result = await askTextarea({
      title: "导出 API",
      message: "API 已导出为 Holaman JSON。",
      initialValue: text,
      confirmText: "复制",
      cancelText: "关闭",
      readOnly: true,
    });

    if (result) {
      await writeClipboardText(result);
      setNotice("API JSON 已复制");
    }
  };

  const ensureApiPasteCollection = async (collectionId?: string) => {
    if (collectionId) {
      return collectionId;
    }

    if (expandedCollectionId) {
      return expandedCollectionId;
    }

    const collection = await saveCollection("粘贴的 API");
    await refreshCollectionsAndRequests();
    setExpandedCollectionId(collection.id);
    setExpandedCollectionIds((items) => Array.from(new Set([...items, collection.id])));
    return collection.id;
  };

  const importTextIntoTarget = async (text: string, collectionId?: string, allowCollectionAtRoot = true) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    try {
      const payload = JSON.parse(trimmed) as { type?: string };
      if (payload.type === "holaman.collection") {
        await importCollection(payload, allowCollectionAtRoot ? collectionId : undefined);
        await refreshCollectionsAndRequests();
        if (collectionId) {
          setExpandedCollectionIds((items) => Array.from(new Set([...items, collectionId])));
        }
        setNotice("集合已导入");
        return;
      }

      if (payload.type === "holaman.request") {
        const targetCollectionId = await ensureApiPasteCollection(collectionId);
        const imported = await importRequest(payload, targetCollectionId);
        await registerSavedRequest(imported, { expandCollection: true, shouldInsert: true });
        openRequestDraft(imported, `已导入：${requestDisplayName(imported)}`);
        return;
      }
    } catch {
      // Not JSON; try cURL below.
    }

    const targetCollectionId = await ensureApiPasteCollection(collectionId);
    const importedDraft = parseCurl(trimmed, createEmptyRequestDraft(targetCollectionId, draft.environmentId));
    const saved = await saveRequest({ ...importedDraft, collectionId: targetCollectionId });
    await registerSavedRequest(saved, { expandCollection: true, shouldInsert: true });
    openRequestDraft(saved, `已导入：${requestDisplayName(saved)}`);
  };

  const pasteIntoCollection = async (collectionId?: string) => {
    const text = await readClipboardText();
    await importTextIntoTarget(text, collectionId);
  };

  const importIntoCollection = async (collectionId?: string) => {
    const text = await askTextarea({
      title: "导入",
      message: "粘贴 cURL 或 Holaman JSON。",
      initialValue: "",
      placeholder: "curl ... 或 { \"type\": \"holaman.collection\", ... }",
      confirmText: "导入",
      cancelText: "取消",
    });

    if (text) {
      await importTextIntoTarget(text, collectionId);
    }
  };

  const createChildCollection = async (parentId?: string) => {
    const name = (
      await askText({
        title: "创建集合",
        initialValue: "创建集合",
        placeholder: "集合名称",
        confirmText: "创建",
        cancelText: "取消",
      })
    )?.trim();

    if (name) {
      await createCollection(name, parentId);
    }
  };

  const moveExistingCollection = async (collection: Collection, parentId?: string) => {
    await moveCollection(collection.id, parentId);
    await refreshCollectionsAndRequests();
    setExpandedCollectionId(parentId ?? collection.id);
    setExpandedCollectionIds((items) => Array.from(new Set([...items, parentId ?? collection.id])));
    setNotice(`已移动集合：${collection.name}`);
  };

  const moveExistingRequest = async (request: SavedRequest, collectionId?: string) => {
    await moveRequest(request.id, collectionId);
    await refreshCollectionsAndRequests();
    setWorkspaceTabs((items) =>
      items.map((tab) =>
        tab.persistedRequestId === request.id || tab.draft.id === request.id
          ? { ...tab, draft: { ...tab.draft, collectionId }, dirty: false }
          : tab,
      ),
    );
    setExpandedCollectionId(collectionId ?? null);
    if (collectionId) {
      setExpandedCollectionIds((items) => Array.from(new Set([...items, collectionId])));
    }
    setNotice(`已移动 API：${requestDisplayName(request)}`);
  };

  const handleDropOnCollection = async (collectionId: string, payload: DragPayload) => {
    setDropTarget(null);
    if (payload.type === "collection") {
      const collection = collections.find((item) => item.id === payload.id);
      if (collection) await moveExistingCollection(collection, collectionId);
      return;
    }

    const request = findRequestInMap(collectionRequests, payload.id);
    if (request) await moveExistingRequest(request, collectionId);
  };

  const handleDropOnRoot = async (payload: DragPayload) => {
    setDropTarget(null);
    if (payload.type === "collection") {
      const collection = collections.find((item) => item.id === payload.id);
      if (collection) await moveExistingCollection(collection, undefined);
      return;
    }

    const request = findRequestInMap(collectionRequests, payload.id);
    if (request) await moveExistingRequest(request, undefined);
  };

  const beginTreeDrag = (payload: DragPayload, label: string, event: ReactMouseEvent) => {
    const eventTarget = event.target instanceof HTMLElement ? event.target : null;
    if (
      event.button !== 0 ||
      eventTarget?.closest("input, textarea, select, .icon-button, .api-node__delete, .create-row")
    ) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    let isDragging = false;

    const updateTarget = (clientX: number, clientY: number) => {
      const element = document.elementFromPoint(clientX, clientY);
      const target = element?.closest<HTMLElement>("[data-drop-target]");
      if (!target) {
        setDropTarget(null);
        return;
      }

      const targetType = target.dataset.dropTarget;
      if (targetType === "root") {
        setDropTarget({ id: "root", target: "root" });
      }
      if (targetType === "collection" && target.dataset.collectionId) {
        setDropTarget({ id: target.dataset.collectionId, target: "collection" });
      }
    };

    const startDragging = (clientX: number, clientY: number) => {
      if (isDragging) return;
      isDragging = true;
      document.body.classList.add("is-tree-dragging");
      setTreeDrag({ payload, label, x: clientX, y: clientY });
      updateTarget(clientX, clientY);
    };

    const startTimer = window.setTimeout(() => {
      startDragging(startX, startY);
    }, 180);

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDragging && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 6) {
        window.clearTimeout(startTimer);
        startDragging(moveEvent.clientX, moveEvent.clientY);
      }

      if (isDragging) {
        moveEvent.preventDefault();
        setTreeDrag({ payload, label, x: moveEvent.clientX, y: moveEvent.clientY });
        updateTarget(moveEvent.clientX, moveEvent.clientY);
      }
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      window.clearTimeout(startTimer);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.classList.remove("is-tree-dragging");

      if (!isDragging) {
        return;
      }

      const stopNextClick = (clickEvent: MouseEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
      };
      document.addEventListener("click", stopNextClick, { capture: true, once: true });

      const element = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      const target = element?.closest<HTMLElement>("[data-drop-target]");
      setTreeDrag(null);
      setDropTarget(null);

      if (!target) {
        return;
      }

      if (target.dataset.dropTarget === "root") {
        void handleDropOnRoot(payload);
      }
      if (target.dataset.dropTarget === "collection" && target.dataset.collectionId) {
        void handleDropOnCollection(target.dataset.collectionId, payload);
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const handleContextMenuAction = async (action: string) => {
    const target = contextMenu?.target;
    if (!target) return;
    closeContextMenu();

    if (target.type === "collection") {
      const collection = target.collection;
      if (action === "new-collection") await createChildCollection(collection.id);
      if (action === "rename") await renameExistingCollection(collection);
      if (action === "delete") await deleteExistingCollection(collection);
      if (action === "copy") await copyCollectionToClipboard(collection);
      if (action === "paste") await pasteIntoCollection(collection.id);
      if (action === "import") await importIntoCollection(collection.id);
      if (action === "export") await exportCollectionToDialog(collection);
      if (action === "new-request") await createNewRequest(collection.id);
      return;
    }

    if (target.type === "request") {
      const request = target.request;
      const targetCollectionId = request.collectionId ?? undefined;
      if (action === "new-request") await createNewRequest(targetCollectionId ?? null);
      if (action === "copy") await copyRequestToClipboard(request);
      if (action === "paste") await pasteIntoCollection(targetCollectionId);
      if (action === "delete") await deleteExistingRequest(request);
      if (action === "export") await exportRequestToDialog(request);
      if (action === "import") await importIntoCollection(targetCollectionId);
      return;
    }

    if (target.type === "environment") {
      const environment = target.environment;
      if (action === "new-environment") await createEnvironment();
      if (action === "edit-environment") await editEnvironment(environment);
      if (action === "delete-environment") await deleteExistingEnvironment(environment);
      return;
    }

    if (target.type === "environment-root") {
      if (action === "new-environment") await createEnvironment();
      return;
    }

    if (action === "new-collection") await createChildCollection(undefined);
    if (action === "paste") await pasteIntoCollection(undefined);
    if (action === "import") await importIntoCollection(undefined);
    if (action === "new-request") await createNewRequest(null);
  };

  const startColumnResize = (side: "left" | "right", event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startLeft = leftWidth;
    const startRight = rightWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (side === "left") {
        setLeftWidth(clamp(startLeft + moveEvent.clientX - startX, 220, 420));
      } else {
        setRightWidth(clamp(startRight - (moveEvent.clientX - startX), 260, 480));
      }
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const startRowResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = requestHeight;
    const workspaceHeight = window.innerHeight - 136;

    const onMouseMove = (moveEvent: MouseEvent) => {
      setRequestHeight(clamp(startHeight + moveEvent.clientY - startY, 260, workspaceHeight - 240));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const updateRow = (field: "params" | "headers", row: KeyValueRow) => {
    setDraft((current) => {
      const rows = current[field].map((item) => (item.id === row.id ? row : item));
      const hasEmpty = rows.some((item) => !item.key && !item.value);
      return { ...current, [field]: hasEmpty ? rows : [...rows, emptyRow(field)] };
    });
  };

  return (
    <div className="app-shell">
      <GlobalNav activeModule={activeModule} onModuleChange={setActiveModule} />
      <SubNav
        activeModule={activeModule}
        notice={notice}
        autoSaveIntervalMs={autoSaveIntervalMs}
        dirtyCount={workspaceTabs.filter((tab) => tab.dirty && isPersistableDraft(tab.draft)).length}
        isAutoSaving={isAutoSaving}
        onNewRequest={createNewRequest}
        onImport={importCurl}
        onExport={exportAllToDialog}
        environments={environments}
        currentEnvironmentId={currentEnvironment?.id ?? draft.environmentId}
        onEnvironmentChange={selectEnvironment}
      />
      {activeModule === "Workspace" ? (
        <main
          className="workspace"
          style={{
            gridTemplateColumns: `${leftWidth}px 8px minmax(0, 1fr) 8px ${rightWidth}px`,
          }}
        >
          <LeftRail
            activeTab={leftTab}
            onTabChange={setLeftTab}
            collections={collections}
            history={history}
            environments={environments}
            selectedEnvironmentId={currentEnvironment?.id}
            onSelectEnvironment={selectEnvironment}
            onCreateEnvironment={createEnvironment}
            onRenameEnvironment={renameEnvironment}
            onDeleteEnvironment={deleteExistingEnvironment}
            selectedCollectionId={expandedCollectionId ?? draft.collectionId}
            selectedRequestId={draft.id}
            expandedCollectionId={expandedCollectionId}
            expandedCollectionIds={expandedCollectionIds}
            collectionRequests={collectionRequests}
            onCreateCollection={createCollection}
            onSelectCollection={selectCollection}
            onSelectRequest={selectSavedRequest}
            onRenameCollection={renameExistingCollection}
            onDeleteCollection={deleteExistingCollection}
            onDeleteRequest={deleteExistingRequest}
            onContextMenuTarget={openContextMenu}
            onDropOnCollection={handleDropOnCollection}
            onDropOnRoot={handleDropOnRoot}
            dropTarget={dropTarget}
            onDropTargetChange={setDropTarget}
            onBeginTreeDrag={beginTreeDrag}
            onRestoreHistory={(entry) => openRequestDraft(entry.draft, `已恢复历史：${requestDisplayName(entry.draft)}`)}
          />
          <div
            className="resize-handle resize-handle--vertical"
            role="separator"
            aria-label="调整左侧边栏宽度"
            onMouseDown={(event) => startColumnResize("left", event)}
          />
          <section
            className="workbench"
            style={{
              gridTemplateRows: `62px ${requestHeight}px 8px minmax(0, 1fr)`,
            }}
          >
            <WorkspaceRequestTabs
              tabs={workspaceTabs}
              activeTabId={activeWorkspaceTab.id}
              onSelect={setActiveWorkspaceTabId}
              onClose={closeWorkspaceTab}
              onCloseLeft={closeWorkspaceTabsLeft}
              onCloseRight={closeWorkspaceTabsRight}
              onCloseAll={closeAllWorkspaceTabs}
            />
      <RequestEditor
              draft={draft}
              requestTab={requestTab}
              onRequestTabChange={setRequestTab}
              onDraftChange={setDraft}
              onRowChange={updateRow}
              onSend={sendRequest}
              onExportCurl={exportCurl}
              isSending={isSending}
              isDirty={activeWorkspaceTab.dirty}
              environment={currentEnvironment}
              response={response}
              scriptTab={scriptTab}
              onScriptTabChange={setScriptTab}
              scriptLogs={scriptLogs}
            />
            <div
              className="resize-handle resize-handle--horizontal"
              role="separator"
              aria-label="调整请求和响应窗口高度"
              onMouseDown={startRowResize}
            />
            <ResponseViewer
              response={response}
              activeTab={responseTab}
              onTabChange={setResponseTab}
              error={error}
            />
          </section>
          <div
            className="resize-handle resize-handle--vertical"
            role="separator"
            aria-label="调整右侧边栏宽度"
            onMouseDown={(event) => startColumnResize("right", event)}
          />
          <RightPanel
            activeTab={rightTab}
            onTabChange={setRightTab}
            environment={currentEnvironment}
            logs={logs}
            logFilter={logFilter}
            onLogFilterChange={setLogFilter}
            onRefreshLogs={refreshLogs}
            onClearLogs={clearPersistedLogs}
          />
        </main>
      ) : activeModule === "Settings" ? (
        <SettingsPanel
          autoSaveIntervalMs={autoSaveIntervalMs}
          onAutoSaveIntervalChange={setAutoSaveIntervalMs}
        />
      ) : activeModule === "Guide" ? (
        <GuidePanel />
      ) : (
        <ModuleSkeleton module={activeModule} />
      )}
      <AppDialogView dialog={dialog} onClose={() => setDialog(null)} />
      <TreeContextMenu menu={contextMenu} onAction={handleContextMenuAction} onClose={closeContextMenu} />
      <TreeDragPreview drag={treeDrag} />
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function requestDisplayName(request: SavedRequest | RequestDraft): string {
  const name = request.name.trim();
  if (name && name !== "未命名请求" && name !== "Untitled Request") {
    return name;
  }

  return request.url.trim() || "未命名 API";
}

function buildMockPath(draft: RequestDraft): string {
  const fallbackPath = draft.id ? `/mock/${draft.id}` : "/mock/current-request";
  try {
    const url = new URL(draft.url);
    return `/mock${url.pathname === "/" ? fallbackPath : url.pathname}`;
  } catch {
    return fallbackPath;
  }
}

async function createMockResponse(draft: RequestDraft): Promise<HttpResponsePayload> {
  const mock = draft.mockConfig ?? createDefaultMockConfig();
  const started = performance.now();
  if (mock.delayMs > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, mock.delayMs));
  }
  const body = mock.body;
  return {
    status: mock.statusCode,
    statusText: mock.statusCode >= 400 ? "Mock Error" : "Mock OK",
    headers: mock.headers.filter((row) => row.enabled && row.key),
    body,
    durationMs: Math.round(performance.now() - started),
    sizeBytes: new Blob([body]).size,
    url: buildMockPath(draft),
  };
}

function draftToPayload(draft: RequestDraft, environmentId?: string): HttpRequestPayload {
  return {
    method: draft.method,
    url: draft.url,
    params: draft.params,
    headers: draft.headers,
    bodyMode: draft.bodyMode,
    body: draft.body,
    timeoutMs: draft.timeoutMs,
    environmentId,
  };
}

async function runScriptStage({
  stage,
  draft,
  response,
  environment,
}: {
  stage: "pre" | "post";
  draft: RequestDraft;
  response: HttpResponsePayload | null;
  environment?: Environment;
}): Promise<{ draft: RequestDraft; environment?: Environment; logs: ScriptLogEntry[]; failed: boolean }> {
  const scripts = draft.scripts;
  const source = stage === "pre" ? scripts?.preRequest : scripts?.postResponse;
  if (!scripts?.enabled || !source?.trim()) {
    return { draft, environment, logs: [], failed: false };
  }

  const logs: ScriptLogEntry[] = [];
  const mutableDraft = structuredClone(draft);
  let mutableEnvironment = environment ? structuredClone(environment) : undefined;

  const pushLog = (level: ScriptLogLevel, values: unknown[]) => {
    logs.push({
      id: rowId("script-log"),
      time: new Date().toLocaleTimeString(),
      level,
      message: values.map(formatScriptValue).join(" "),
    });
  };

  const scriptConsole = {
    log: (...values: unknown[]) => pushLog("log", values),
    warn: (...values: unknown[]) => pushLog("warn", values),
    error: (...values: unknown[]) => pushLog("error", values),
  };

  const envApi = {
    get: (key: string) => mutableEnvironment?.variables.find((item) => item.enabled && item.key === key)?.value,
    set: (key: string, value: unknown) => {
      const now = new Date().toISOString();
      const nextValue = String(value ?? "");
      if (!mutableEnvironment) {
        throw new Error("env.set 需要先选择一个环境");
      }
      const existing = mutableEnvironment.variables.find((item) => item.key === key);
      if (existing) {
        existing.value = nextValue;
        existing.enabled = true;
      } else {
        mutableEnvironment.variables.push({
          id: rowId("variable"),
          key,
          value: nextValue,
          enabled: true,
          secret: /token|secret|password|key/i.test(key),
        });
      }
      mutableEnvironment.updatedAt = now;
    },
    delete: (key: string) => {
      if (!mutableEnvironment) return;
      mutableEnvironment.variables = mutableEnvironment.variables.filter((item) => item.key !== key);
      mutableEnvironment.updatedAt = new Date().toISOString();
    },
  };

  const requestApi = createScriptRequestApi(mutableDraft);
  const responseApi = response ? createScriptResponseApi(response) : undefined;
  const expectApi = (actual: unknown) => ({
    toBe: (expected: unknown) => {
      const passed = Object.is(actual, expected);
      pushLog(passed ? "pass" : "fail", [
        passed ? "PASS" : "FAIL",
        `expect(${formatScriptValue(actual)}).toBe(${formatScriptValue(expected)})`,
      ]);
      if (!passed) throw new Error(`断言失败：期望 ${formatScriptValue(expected)}，实际 ${formatScriptValue(actual)}`);
    },
    toContain: (expected: unknown) => {
      const passed = String(actual ?? "").includes(String(expected ?? ""));
      pushLog(passed ? "pass" : "fail", [
        passed ? "PASS" : "FAIL",
        `expect(...).toContain(${formatScriptValue(expected)})`,
      ]);
      if (!passed) throw new Error(`断言失败：内容不包含 ${formatScriptValue(expected)}`);
    },
    toBeLessThan: (expected: number) => {
      const passed = Number(actual) < expected;
      pushLog(passed ? "pass" : "fail", [
        passed ? "PASS" : "FAIL",
        `expect(${Number(actual)}).toBeLessThan(${expected})`,
      ]);
      if (!passed) throw new Error(`断言失败：${Number(actual)} 不小于 ${expected}`);
    },
  });

  try {
    const runner = new Function(
      "request",
      "response",
      "env",
      "console",
      "expect",
      "uuid",
      "timestamp",
      "window",
      "document",
      "fetch",
      "XMLHttpRequest",
      "localStorage",
      "sessionStorage",
      "require",
      "importScripts",
      `"use strict";\n${source}`,
    );
    await Promise.race([
      Promise.resolve(
        runner(
          requestApi,
          responseApi,
          envApi,
          scriptConsole,
          expectApi,
          crypto.randomUUID.bind(crypto),
          () => Date.now(),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ),
      ),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("脚本执行超时")), 1000)),
    ]);
    return { draft: mutableDraft, environment: mutableEnvironment, logs, failed: false };
  } catch (caught) {
    pushLog("error", [caught instanceof Error ? caught.message : String(caught)]);
    return { draft: mutableDraft, environment: mutableEnvironment, logs, failed: true };
  }
}

function createScriptRequestApi(draft: RequestDraft) {
  return {
    get url() {
      return draft.url;
    },
    set url(value: string) {
      draft.url = String(value ?? "");
    },
    get method() {
      return draft.method;
    },
    set method(value: HttpMethod) {
      draft.method = value;
    },
    params: createRowMapApi(draft.params),
    headers: createRowMapApi(draft.headers),
    body: {
      get: () => draft.body,
      set: (value: unknown) => {
        draft.body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      },
    },
    bodyMode: {
      get: () => draft.bodyMode,
      set: (value: BodyMode) => {
        draft.bodyMode = value;
      },
    },
  };
}

function createRowMapApi(rows: KeyValueRow[]) {
  return {
    get: (key: string) => rows.find((row) => row.enabled && row.key.toLowerCase() === key.toLowerCase())?.value,
    set: (key: string, value: unknown) => {
      const existing = rows.find((row) => row.key.toLowerCase() === key.toLowerCase());
      if (existing) {
        existing.value = String(value ?? "");
        existing.enabled = true;
        return;
      }
      rows.push({ ...emptyRow("script-row"), key, value: String(value ?? "") });
    },
    delete: (key: string) => {
      const existing = rows.find((row) => row.key.toLowerCase() === key.toLowerCase());
      if (existing) existing.enabled = false;
    },
  };
}

function createScriptResponseApi(response: HttpResponsePayload) {
  return {
    status: response.status,
    time: response.durationMs,
    headers: {
      get: (key: string) =>
        response.headers.find((row) => row.key.toLowerCase() === key.toLowerCase())?.value,
    },
    text: () => response.body,
    json: () => JSON.parse(response.body),
  };
}

function formatScriptValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function persistScriptLogs(
  logs: ScriptLogEntry[],
  stage: "pre-script" | "post-script",
  draft: RequestDraft,
  appendLog: (entry: Omit<LogEntry, "id" | "createdAt">) => Promise<void>,
  response?: HttpResponsePayload,
) {
  for (const log of logs) {
    await appendLog({
      requestId: draft.id,
      requestName: requestDisplayName(draft),
      method: draft.method,
      url: response?.url ?? draft.url,
      status: response?.status,
      durationMs: response?.durationMs,
      sizeBytes: response?.sizeBytes,
      level: scriptLogLevelToAppLogLevel(log.level),
      stage,
      message: log.message,
      requestBody: formatRequestLogSnapshot(draft),
      responseBody: response?.body,
    });
  }
}

function scriptLogLevelToAppLogLevel(level: ScriptLogLevel): LogLevel {
  if (level === "warn") return "warn";
  if (level === "error") return "error";
  if (level === "pass") return "assert-pass";
  if (level === "fail") return "assert-fail";
  return "script";
}

function formatRequestLogSnapshot(draft: RequestDraft): string {
  return JSON.stringify(
    {
      name: requestDisplayName(draft),
      method: draft.method,
      url: draft.url,
      params: draft.params
        .filter((row) => row.enabled && (row.key || row.value))
        .map(({ key, value, description }) => ({ key, value, description })),
      headers: draft.headers
        .filter((row) => row.enabled && (row.key || row.value))
        .map(({ key, value, description }) => ({ key, value, description })),
      bodyMode: draft.bodyMode,
      body: draft.body,
      timeoutMs: draft.timeoutMs,
      environmentId: draft.environmentId,
    },
    null,
    2,
  );
}

function collectionRequestKey(collectionId?: string | null): string {
  return collectionId ?? rootRequestKey;
}

function buildCollectionTree(
  collections: Collection[],
  collectionRequests: Record<string, SavedRequest[]>,
): CollectionTreeNode[] {
  const buildNode = (collection: Collection): CollectionTreeNode => ({
    collection,
    requests: collectionRequests[collection.id] ?? [],
    children: collections
      .filter((item) => item.parentId === collection.id)
      .map(buildNode),
  });

  return collections
    .filter((collection) => !collection.parentId)
    .map(buildNode);
}

function collectionDescendantIds(collections: Collection[], rootId: string): string[] {
  const ids = [rootId];
  for (let index = 0; index < ids.length; index += 1) {
    for (const collection of collections.filter((item) => item.parentId === ids[index])) {
      ids.push(collection.id);
    }
  }
  return ids;
}

function findRequestInMap(
  collectionRequests: Record<string, SavedRequest[]>,
  requestId: string,
): SavedRequest | undefined {
  return Object.values(collectionRequests)
    .flat()
    .find((request) => request.id === requestId);
}

function readPersistedAppState(): PersistedAppState | null {
  try {
    const rawValue = localStorage.getItem(appStateStorageKey);
    if (!rawValue) {
      return null;
    }

    const value = JSON.parse(rawValue) as PersistedAppState;
    if (value.version !== 1 || !Array.isArray(value.workspaceTabs)) {
      return null;
    }

    const workspaceTabs = value.workspaceTabs
      .filter((tab) => tab?.draft)
      .map((tab) => ({
        ...createWorkspaceRequestTab(
          tab.draft,
          tab.id || rowId("request-tab"),
          Boolean(tab.dirty),
        ),
        persistedRequestId: tab.persistedRequestId ?? tab.draft.id,
        response: tab.response ?? null,
        error: tab.error ?? null,
        requestTab: requestTabs.includes(tab.requestTab) ? tab.requestTab : "Params",
        responseTab: responseTabs.includes(tab.responseTab) ? tab.responseTab : "Body",
        scriptTab: ["pre", "post", "logs"].includes(tab.scriptTab) ? tab.scriptTab : "pre",
        scriptLogs: [],
      }));

    if (workspaceTabs.length === 0) {
      return null;
    }

    const activeWorkspaceTabId = workspaceTabs.some((tab) => tab.id === value.activeWorkspaceTabId)
      ? value.activeWorkspaceTabId
      : workspaceTabs[0].id;

    return {
      version: 1,
      activeModule: value.activeModule === "Collections" || value.activeModule === "Environments" || value.activeModule === "Mock" || value.activeModule === "Runner"
        ? "Workspace"
        : value.activeModule || "Workspace",
      leftTab: value.leftTab || "Collections",
      rightTab: value.rightTab === "Console" ? "Logs" : value.rightTab || "Variables",
      workspaceTabs,
      activeWorkspaceTabId,
      expandedCollectionId: value.expandedCollectionId ?? workspaceTabs[0].draft.collectionId ?? null,
      leftWidth: clamp(value.leftWidth || 280, 220, 420),
      rightWidth: clamp(value.rightWidth || 320, 260, 480),
      requestHeight: clamp(value.requestHeight || 420, 260, 900),
      expandedCollectionIds: Array.isArray(value.expandedCollectionIds)
        ? value.expandedCollectionIds
        : value.expandedCollectionId
          ? [value.expandedCollectionId]
          : [],
    };
  } catch {
    return null;
  }
}

function writePersistedAppState(state: PersistedAppState): void {
  try {
    localStorage.setItem(appStateStorageKey, JSON.stringify(state));
  } catch {
    // Large responses may exceed WebView storage quota; runtime data remains safe in SQLite.
  }
}

function hasCustomRequestName(request: SavedRequest | RequestDraft): boolean {
  const name = request.name.trim();
  return Boolean(name && name !== "未命名请求" && name !== "Untitled Request");
}

function preserveRequestIdentity(draft: RequestDraft, tab: WorkspaceRequestTab): RequestDraft {
  return {
    ...draft,
    id: draft.id ?? tab.persistedRequestId ?? tab.draft.id,
    collectionId: draft.collectionId ?? tab.draft.collectionId,
  };
}

function formatAutoSaveInterval(value: number): string {
  return value >= 1000 ? `${value / 1000} 秒` : `${value} ms`;
}

function serializeEnvironmentVariablesText(environment: Environment): string {
  return environment.variables.map((variable) => `${variable.key}=${variable.value}`).join("\n");
}

function parseEnvironmentVariablesText(text: string): EnvironmentVariable[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const variables: EnvironmentVariable[] = [];

  for (const line of lines) {
    const separatorIndex = line.indexOf("=");
    const rawKey = separatorIndex >= 0 ? line.slice(0, separatorIndex).trim() : line.trim();
    const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trim() : "";
    if (!rawKey) continue;

    variables.push({
      id: rowId("variable"),
      key: rawKey,
      value,
      enabled: true,
      secret: /token|secret|password|key/i.test(rawKey),
    });
  }

  return variables;
}

function readAutoSaveIntervalMs(): number {
  try {
    const storedValue = Number(localStorage.getItem(autoSaveIntervalStorageKey));
    if (autoSaveIntervalOptions.includes(storedValue)) {
      return storedValue;
    }
  } catch {
    // Ignore storage failures in restricted WebView contexts.
  }

  return 5000;
}

function isPersistableDraft(draft: RequestDraft): boolean {
  if (draft.id) {
    return true;
  }

  const hasRows = [...draft.params, ...draft.headers].some(
    (row) => row.key.trim() || row.value.trim() || row.description?.trim(),
  );

  return Boolean(
    hasCustomRequestName(draft) ||
      draft.url.trim() ||
      draft.body.trim() ||
      draft.scripts?.preRequest.trim() ||
      draft.scripts?.postResponse.trim() ||
      draft.bodyMode !== "none" ||
      hasRows,
  );
}

function requestDraftSignature(draft: RequestDraft): string {
  return JSON.stringify({
    id: draft.id,
    name: draft.name,
    collectionId: draft.collectionId,
    method: draft.method,
    url: draft.url,
    params: draft.params,
    headers: draft.headers,
    bodyMode: draft.bodyMode,
    body: draft.body,
      timeoutMs: draft.timeoutMs,
      environmentId: draft.environmentId,
      mockConfig: draft.mockConfig,
      scripts: draft.scripts,
  });
}

function syncCollectionRequestsFromTabs(
  items: Record<string, SavedRequest[]>,
  tabs: WorkspaceRequestTab[],
): Record<string, SavedRequest[]> {
  let nextItems = items;
  let changed = false;

  for (const tab of tabs) {
    const draft = tab.draft;
    const requestId = draft.id ?? tab.persistedRequestId;
    const requestKey = collectionRequestKey(draft.collectionId);
    if (!requestId || !nextItems[requestKey]) {
      continue;
    }

    const nextRequests = nextItems[requestKey].map((request) => {
      if (request.id !== requestId) {
        return request;
      }

      if (
        request.name === draft.name &&
        request.method === draft.method &&
        request.url === draft.url &&
        request.bodyMode === draft.bodyMode &&
        request.body === draft.body &&
        request.environmentId === draft.environmentId &&
        JSON.stringify(request.mockConfig) === JSON.stringify(draft.mockConfig) &&
        JSON.stringify(request.scripts) === JSON.stringify(draft.scripts) &&
        JSON.stringify(request.params) === JSON.stringify(draft.params) &&
        JSON.stringify(request.headers) === JSON.stringify(draft.headers)
      ) {
        return request;
      }

      changed = true;
      return {
        ...request,
        ...draft,
        id: request.id,
        collectionId: request.collectionId,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      };
    });

    if (changed) {
      nextItems = { ...nextItems, [requestKey]: nextRequests };
    }
  }

  return changed ? nextItems : items;
}

function WorkspaceRequestTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onCloseLeft,
  onCloseRight,
  onCloseAll,
}: {
  tabs: WorkspaceRequestTab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseLeft: (tabId: string) => void;
  onCloseRight: (tabId: string) => void;
  onCloseAll: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  const runMenuAction = (action: "close" | "close-left" | "close-right" | "close-all") => {
    if (!menu) return;
    const tabId = menu.tabId;
    setMenu(null);
    if (action === "close") onClose(tabId);
    if (action === "close-left") onCloseLeft(tabId);
    if (action === "close-right") onCloseRight(tabId);
    if (action === "close-all") onCloseAll();
  };

  return (
    <div className="workspace-request-tabs" role="tablist" aria-label="请求标签">
      {tabs.map((tab) => (
        <div
          className={tab.id === activeTabId ? "workspace-request-tab is-active" : "workspace-request-tab"}
          key={tab.id}
          onContextMenu={(event) => {
            event.preventDefault();
            onSelect(tab.id);
            setMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
          }}
        >
          <button
            className="workspace-request-tab__main"
            role="tab"
            aria-selected={tab.id === activeTabId}
            onClick={() => onSelect(tab.id)}
            title={requestDisplayName(tab.draft)}
          >
            <span className="method-chip">{tab.draft.method}</span>
            <span>{requestDisplayName(tab.draft)}</span>
          </button>
          <button
            className="workspace-request-tab__close"
            aria-label={`关闭 ${requestDisplayName(tab.draft)}`}
            title="关闭"
            onClick={() => onClose(tab.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {menu && (
        <div
          className="tree-context-menu workspace-tab-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <button onClick={() => runMenuAction("close")} role="menuitem">
            <X size={15} />
            <span>关闭当前</span>
          </button>
          <button
            onClick={() => runMenuAction("close-left")}
            role="menuitem"
            disabled={tabs.findIndex((tab) => tab.id === menu.tabId) <= 0}
          >
            <X size={15} />
            <span>关闭左侧全部</span>
          </button>
          <button
            onClick={() => runMenuAction("close-right")}
            role="menuitem"
            disabled={tabs.findIndex((tab) => tab.id === menu.tabId) >= tabs.length - 1}
          >
            <X size={15} />
            <span>关闭右侧全部</span>
          </button>
          <button onClick={() => runMenuAction("close-all")} role="menuitem">
            <X size={15} />
            <span>关闭全部</span>
          </button>
        </div>
      )}
    </div>
  );
}

function TreeContextMenu({
  menu,
  onAction,
  onClose,
}: {
  menu: ContextMenuState | null;
  onAction: (action: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const items =
    menu.target.type === "collection"
      ? [
          ["new-collection", Plus, "创建集合"],
          ["rename", Pencil, "重命名"],
          ["delete", Trash2, "删除"],
          ["copy", Copy, "复制"],
          ["paste", Clipboard, "粘贴"],
          ["import", Upload, "导入"],
          ["export", Download, "导出"],
          ["new-request", FileJson2, "创建 API"],
        ] as const
      : menu.target.type === "request"
        ? [
            ["new-request", FileJson2, "创建 API"],
            ["copy", Copy, "复制"],
            ["paste", Clipboard, "粘贴"],
            ["delete", Trash2, "删除"],
            ["export", Download, "导出"],
            ["import", Upload, "导入"],
          ] as const
        : menu.target.type === "environment"
          ? [
              ["new-environment", Plus, "创建环境"],
              ["edit-environment", Pencil, "编辑变量"],
              ["delete-environment", Trash2, "删除"],
            ] as const
          : menu.target.type === "environment-root"
            ? [["new-environment", Plus, "创建环境"]] as const
        : [
            ["new-collection", Plus, "创建集合"],
            ["paste", Clipboard, "粘贴"],
            ["import", Upload, "导入"],
            ["new-request", FileJson2, "创建 API"],
          ] as const;

  return (
    <div
      className="tree-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      role="menu"
    >
      {items.map(([action, Icon, label]) => (
        <button key={action} onClick={() => onAction(action)} role="menuitem">
          <Icon size={15} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function TreeDragPreview({ drag }: { drag: TreeDragState }) {
  if (!drag) return null;
  const Icon = drag.payload.type === "collection" ? Folder : FileJson2;

  return (
    <div className="tree-drag-preview" style={{ left: drag.x + 12, top: drag.y + 12 }}>
      <Icon size={15} />
      <span>{drag.label}</span>
    </div>
  );
}

function AppDialogView({ dialog, onClose }: { dialog: AppDialog | null; onClose: () => void }) {
  const [textValue, setTextValue] = useState("");

  useEffect(() => {
    if (dialog?.type === "text" || dialog?.type === "textarea") {
      setTextValue(dialog.initialValue);
    }
  }, [dialog]);

  if (!dialog) {
    return null;
  }

  const cancel = () => {
    if (dialog.type === "text" || dialog.type === "textarea") {
      dialog.resolve(null);
    } else {
      dialog.resolve(false);
    }
    onClose();
  };

  const confirm = () => {
    if (dialog.type === "text" || dialog.type === "textarea") {
      dialog.resolve(textValue);
    } else {
      dialog.resolve(true);
    }
    onClose();
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={cancel}>
      <section
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="app-dialog-title">{dialog.title}</h2>
        {"message" in dialog && dialog.message && <p>{dialog.message}</p>}
        {dialog.type === "confirm" && dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
        {dialog.type === "text" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            <input
              autoFocus
              value={textValue}
              placeholder={dialog.placeholder}
              onChange={(event) => setTextValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  cancel();
                }
              }}
            />
          </form>
        )}
        {dialog.type === "textarea" && (
          <textarea
            autoFocus
            readOnly={dialog.readOnly}
            value={textValue}
            placeholder={dialog.placeholder}
            onChange={(event) => setTextValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                cancel();
              }
            }}
          />
        )}
        <div className="dialog-actions">
          <button className="button-secondary" onClick={cancel}>
            {dialog.cancelText}
          </button>
          <button
            className={dialog.type === "confirm" && dialog.danger ? "button-primary button-danger" : "button-primary"}
            onClick={confirm}
          >
            {dialog.confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}

function GlobalNav({
  activeModule,
  onModuleChange,
}: {
  activeModule: string;
  onModuleChange: (module: string) => void;
}) {
  const modules = [
    { name: "Workspace", icon: Globe2 },
    { name: "Guide", icon: BookOpen },
    { name: "Settings", icon: Settings },
  ];

  return (
    <header className="global-nav">
      <div className="brand">Holaman</div>
      <nav className="global-nav__links">
        {modules.map(({ name, icon: Icon }) => (
          <button
            key={name}
            className={activeModule === name ? "global-nav__link is-active" : "global-nav__link"}
            onClick={() => onModuleChange(name)}
          >
            <Icon size={14} />
            <span>{t(name)}</span>
          </button>
        ))}
      </nav>
      <div className="global-nav__actions">
        <Search size={15} />
        <span>本地</span>
      </div>
    </header>
  );
}

function SubNav({
  activeModule,
  notice,
  autoSaveIntervalMs,
  dirtyCount,
  isAutoSaving,
  onNewRequest,
  onImport,
  onExport,
  environments,
  currentEnvironmentId,
  onEnvironmentChange,
}: {
  activeModule: string;
  notice: string | null;
  autoSaveIntervalMs: number;
  dirtyCount: number;
  isAutoSaving: boolean;
  onNewRequest: () => void;
  onImport: () => void;
  onExport: () => void;
  environments: Environment[];
  currentEnvironmentId?: string;
  onEnvironmentChange: (environmentId: string) => void;
}) {
  const syncLabel = isAutoSaving
    ? "自动保存中"
    : dirtyCount > 0
      ? `等待自动保存 · ${formatAutoSaveInterval(autoSaveIntervalMs)}`
      : `自动保存 · ${formatAutoSaveInterval(autoSaveIntervalMs)}`;

  return (
    <div className="sub-nav">
      <div>
        <h1>{activeModule === "Workspace" ? "工作台" : t(activeModule)}</h1>
      </div>
      {activeModule === "Workspace" ? (
        <div className="sub-nav__actions">
          <span className="notice-pill">{notice ?? syncLabel}</span>
          <label className="environment-picker">
            <Variable size={15} />
            <span>环境</span>
            <select
              value={currentEnvironmentId ?? ""}
              onChange={(event) => onEnvironmentChange(event.target.value)}
              disabled={environments.length === 0}
            >
              {environments.length === 0 ? (
                <option value="">未配置</option>
              ) : (
                environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))
              )}
            </select>
          </label>
          <button className="button-secondary" onClick={onImport}>
            导入
          </button>
          <button className="button-secondary" onClick={onExport}>
            导出全部
          </button>
          <button className="button-secondary" onClick={() => onNewRequest()}>
            <Plus size={15} />
            创建请求
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LeftRail({
  activeTab,
  onTabChange,
  collections,
  history,
  environments,
  selectedEnvironmentId,
  onSelectEnvironment,
  onCreateEnvironment,
  onRenameEnvironment,
  onDeleteEnvironment,
  selectedCollectionId,
  selectedRequestId,
  expandedCollectionId,
  expandedCollectionIds,
  collectionRequests,
  onCreateCollection,
  onSelectCollection,
  onSelectRequest,
  onRenameCollection,
  onDeleteCollection,
  onDeleteRequest,
  onContextMenuTarget,
  onDropOnCollection,
  onDropOnRoot,
  dropTarget,
  onDropTargetChange,
  onBeginTreeDrag,
  onRestoreHistory,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  collections: Collection[];
  history: HistoryEntry[];
  environments: Environment[];
  selectedEnvironmentId?: string;
  onSelectEnvironment: (environmentId: string) => void;
  onCreateEnvironment: () => void;
  onRenameEnvironment: (environment: Environment, name: string) => Promise<void>;
  onDeleteEnvironment: (environment: Environment) => void;
  selectedCollectionId?: string;
  selectedRequestId?: string;
  expandedCollectionId: string | null;
  expandedCollectionIds: string[];
  collectionRequests: Record<string, SavedRequest[]>;
  onCreateCollection: (name: string) => Promise<void>;
  onSelectCollection: (collection: Collection) => void;
  onSelectRequest: (request: SavedRequest) => void;
  onRenameCollection: (collection: Collection) => void;
  onDeleteCollection: (collection: Collection) => void;
  onDeleteRequest: (request: SavedRequest) => void;
  onContextMenuTarget: (event: ReactMouseEvent, target: ContextMenuTarget) => void;
  onDropOnCollection: (collectionId: string, payload: DragPayload) => void;
  onDropOnRoot: (payload: DragPayload) => void;
  dropTarget: DropTargetState;
  onDropTargetChange: (target: DropTargetState) => void;
  onBeginTreeDrag: (payload: DragPayload, label: string, event: ReactMouseEvent) => void;
  onRestoreHistory: (entry: HistoryEntry) => void;
}) {
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [editingEnvironmentId, setEditingEnvironmentId] = useState<string | null>(null);
  const [editingEnvironmentName, setEditingEnvironmentName] = useState("");
  const collectionTree = useMemo(
    () => buildCollectionTree(collections, collectionRequests),
    [collections, collectionRequests],
  );
  const rootRequests = collectionRequests[rootRequestKey] ?? [];

  const beginCreateCollection = () => {
    setNewCollectionName("");
    setIsCreatingCollection(true);
  };

  const commitCreateCollection = async () => {
    const name = newCollectionName.trim();
    setIsCreatingCollection(false);
    setNewCollectionName("");

    if (!name) {
      return;
    }

    await onCreateCollection(name);
  };

  const cancelCreateCollection = () => {
    setIsCreatingCollection(false);
    setNewCollectionName("");
  };

  const beginRenameEnvironment = (environment: Environment) => {
    setEditingEnvironmentId(environment.id);
    setEditingEnvironmentName(environment.name);
  };

  const commitRenameEnvironment = async (environment: Environment) => {
    const name = editingEnvironmentName.trim();
    setEditingEnvironmentId(null);
    setEditingEnvironmentName("");
    if (name) {
      await onRenameEnvironment(environment, name);
    }
  };

  const cancelRenameEnvironment = () => {
    setEditingEnvironmentId(null);
    setEditingEnvironmentName("");
  };

  return (
    <aside className="left-rail">
      <SegmentedControl items={["Collections", "History", "Environments"]} active={activeTab} onChange={onTabChange} />
      <div className="search-input">
        <Search size={15} />
        <input placeholder={`搜索${t(activeTab)}`} />
      </div>

      {activeTab === "Collections" && (
        <div
          className="rail-list"
          data-drop-target="root"
        >
          {collections.length === 0 && rootRequests.length === 0 ? (
            isCreatingCollection ? (
              <CollectionCreateRow
                value={newCollectionName}
                onChange={setNewCollectionName}
                onCommit={commitCreateCollection}
                onCancel={cancelCreateCollection}
              />
            ) : (
              <EmptyRail icon={Folder} title="还没有请求集合" action="创建集合" onAction={beginCreateCollection} />
            )
          ) : (
            <>
              <button className="create-row" onClick={beginCreateCollection}>
                <Plus size={15} />
                创建集合
              </button>
              {isCreatingCollection && (
                <CollectionCreateRow
                  value={newCollectionName}
                  onChange={setNewCollectionName}
                  onCommit={commitCreateCollection}
                  onCancel={cancelCreateCollection}
                />
              )}
              <RootDropZone
                requests={rootRequests}
                selectedRequestId={selectedRequestId}
                onSelectRequest={onSelectRequest}
                onDeleteRequest={onDeleteRequest}
                onContextMenuTarget={onContextMenuTarget}
                isDragOver={dropTarget?.target === "root"}
                onBeginTreeDrag={onBeginTreeDrag}
              />
              {collectionTree.map((node) => (
                <CollectionTreeItem
                  key={node.collection.id}
                  node={node}
                  depth={0}
                  selectedCollectionId={selectedCollectionId}
                  selectedRequestId={selectedRequestId}
                  expandedCollectionIds={expandedCollectionIds}
                  onSelectCollection={onSelectCollection}
                  onSelectRequest={onSelectRequest}
                  onRenameCollection={onRenameCollection}
                  onDeleteCollection={onDeleteCollection}
                  onDeleteRequest={onDeleteRequest}
                  onContextMenuTarget={onContextMenuTarget}
                  onDropOnCollection={onDropOnCollection}
                  dropTarget={dropTarget}
                  onDropTargetChange={onDropTargetChange}
                  onBeginTreeDrag={onBeginTreeDrag}
                />
              ))}
            </>
          )}
        </div>
      )}

      {activeTab === "History" && (
        <div className="rail-list">
          {history.length === 0 ? (
            <EmptyRail icon={History} title="请求历史会显示在这里" action="发送请求" />
          ) : (
            history.map((entry) => (
              <button className="history-node" key={entry.id} onClick={() => onRestoreHistory(entry)}>
                <span className="method-chip">{entry.method}</span>
                <span className="history-node__url">{entry.url}</span>
                <span className="history-node__meta">
                  {entry.status ?? "-"} · {entry.durationMs ?? "-"} ms
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {activeTab === "Environments" && (
        <div className="rail-list" onContextMenu={(event) => onContextMenuTarget(event, { type: "environment-root" })}>
          <button className="create-row" onClick={onCreateEnvironment} onContextMenu={(event) => event.stopPropagation()}>
            <Plus size={15} />
            创建环境
          </button>
          {environments.length === 0 ? (
            <EmptyRail icon={Database} title="还没有环境" action="等待初始化" />
          ) : (
            environments.map((environment) => (
              editingEnvironmentId === environment.id ? (
                <div className="environment-row" key={environment.id}>
                  <div className="collection-create-row environment-row__editor">
                    <Database size={15} />
                    <input
                      autoFocus
                      value={editingEnvironmentName}
                      onChange={(event) => setEditingEnvironmentName(event.target.value)}
                      onBlur={() => void commitRenameEnvironment(environment)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void commitRenameEnvironment(environment);
                        if (event.key === "Escape") cancelRenameEnvironment();
                      }}
                      placeholder="环境名称"
                    />
                  </div>
                </div>
              ) : (
                <div
                  className="environment-row"
                  key={environment.id}
                  onContextMenu={(event) => {
                    event.stopPropagation();
                    onContextMenuTarget(event, { type: "environment", environment });
                  }}
                >
                  <button
                    className={
                      environment.id === selectedEnvironmentId
                        ? "tree-node environment-row__main is-selected"
                        : "tree-node environment-row__main"
                    }
                    onClick={() => onSelectEnvironment(environment.id)}
                    onDoubleClick={() => beginRenameEnvironment(environment)}
                  >
                    <Database size={15} />
                    <span>{environment.name}</span>
                    <small>{environment.variables.filter((variable) => variable.enabled).length} 变量</small>
                  </button>
                  <div className="collection-row__actions">
                    <button
                      className="icon-button"
                      aria-label={`重命名 ${environment.name}`}
                      title="重命名"
                      onClick={() => beginRenameEnvironment(environment)}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`删除 ${environment.name}`}
                      title="删除"
                      onClick={() => onDeleteEnvironment(environment)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )
            ))
          )}
        </div>
      )}
    </aside>
  );
}

function RootDropZone({
  requests,
  selectedRequestId,
  onSelectRequest,
  onDeleteRequest,
  onContextMenuTarget,
  isDragOver,
  onBeginTreeDrag,
}: {
  requests: SavedRequest[];
  selectedRequestId?: string;
  onSelectRequest: (request: SavedRequest) => void;
  onDeleteRequest: (request: SavedRequest) => void;
  onContextMenuTarget: (event: ReactMouseEvent, target: ContextMenuTarget) => void;
  isDragOver: boolean;
  onBeginTreeDrag: (payload: DragPayload, label: string, event: ReactMouseEvent) => void;
}) {
  return (
    <div
      data-drop-target="root"
      className={isDragOver ? "root-drop-zone is-drag-over" : "root-drop-zone"}
      onContextMenu={(event) => onContextMenuTarget(event, { type: "root" })}
    >
      <div className="root-drop-zone__label">顶层</div>
      {requests.map((request) => (
        <ApiTreeNode
          key={request.id}
          request={request}
          selectedRequestId={selectedRequestId}
          onSelectRequest={onSelectRequest}
          onDeleteRequest={onDeleteRequest}
          onContextMenuTarget={onContextMenuTarget}
          onBeginTreeDrag={onBeginTreeDrag}
        />
      ))}
    </div>
  );
}

function CollectionTreeItem({
  node,
  depth,
  selectedCollectionId,
  selectedRequestId,
  expandedCollectionIds,
  onSelectCollection,
  onSelectRequest,
  onRenameCollection,
  onDeleteCollection,
  onDeleteRequest,
  onContextMenuTarget,
  onDropOnCollection,
  dropTarget,
  onDropTargetChange,
  onBeginTreeDrag,
}: {
  node: CollectionTreeNode;
  depth: number;
  selectedCollectionId?: string;
  selectedRequestId?: string;
  expandedCollectionIds: string[];
  onSelectCollection: (collection: Collection) => void;
  onSelectRequest: (request: SavedRequest) => void;
  onRenameCollection: (collection: Collection) => void;
  onDeleteCollection: (collection: Collection) => void;
  onDeleteRequest: (request: SavedRequest) => void;
  onContextMenuTarget: (event: ReactMouseEvent, target: ContextMenuTarget) => void;
  onDropOnCollection: (collectionId: string, payload: DragPayload) => void;
  dropTarget: DropTargetState;
  onDropTargetChange: (target: DropTargetState) => void;
  onBeginTreeDrag: (payload: DragPayload, label: string, event: ReactMouseEvent) => void;
}) {
  const { collection } = node;
  const isDragOver = dropTarget?.target === "collection" && dropTarget.id === collection.id;
  const hasChildren = node.requests.length > 0 || node.children.length > 0;
  const isExpanded = expandedCollectionIds.includes(collection.id);
  return (
    <div
      className="collection-row"
      data-drop-target="collection"
      data-collection-id={collection.id}
      style={{ paddingLeft: depth * 14 }}
    >
      <div
        className={isDragOver ? "collection-row__header is-drag-over" : "collection-row__header"}
        onMouseDown={(event) => onBeginTreeDrag({ type: "collection", id: collection.id }, collection.name, event)}
        onContextMenu={(event) => onContextMenuTarget(event, { type: "collection", collection })}
      >
        <button
          className={
            collection.id === selectedCollectionId
              ? "tree-node collection-row__main is-selected"
              : "tree-node collection-row__main"
          }
          onClick={() => onSelectCollection(collection)}
        >
          <ChevronDown
            className={
              hasChildren
                ? isExpanded
                  ? "collection-toggle is-expanded"
                  : "collection-toggle"
                : "collection-toggle is-empty"
            }
            size={13}
          />
          <Folder size={15} />
          <span>{collection.name}</span>
          <small>{collection.requestCount} API</small>
        </button>
        <div className="collection-row__actions">
          <button
            className="icon-button"
            draggable={false}
            aria-label={`重命名 ${collection.name}`}
            title="重命名"
            onClick={() => onRenameCollection(collection)}
          >
            <Pencil size={14} />
          </button>
          <button
            className="icon-button"
            draggable={false}
            aria-label={`删除 ${collection.name}`}
            title="删除"
            onClick={() => onDeleteCollection(collection)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {hasChildren && isExpanded && (
        <div className="collection-api-list">
          {node.requests.map((request) => (
            <ApiTreeNode
              key={request.id}
              request={request}
              selectedRequestId={selectedRequestId}
              onSelectRequest={onSelectRequest}
              onDeleteRequest={onDeleteRequest}
              onContextMenuTarget={onContextMenuTarget}
              onBeginTreeDrag={onBeginTreeDrag}
            />
          ))}
          {node.children.map((child) => (
            <CollectionTreeItem
              key={child.collection.id}
              node={child}
              depth={depth + 1}
              selectedCollectionId={selectedCollectionId}
              selectedRequestId={selectedRequestId}
              expandedCollectionIds={expandedCollectionIds}
              onSelectCollection={onSelectCollection}
              onSelectRequest={onSelectRequest}
              onRenameCollection={onRenameCollection}
              onDeleteCollection={onDeleteCollection}
              onDeleteRequest={onDeleteRequest}
              onContextMenuTarget={onContextMenuTarget}
              onDropOnCollection={onDropOnCollection}
              dropTarget={dropTarget}
              onDropTargetChange={onDropTargetChange}
              onBeginTreeDrag={onBeginTreeDrag}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ApiTreeNode({
  request,
  selectedRequestId,
  onSelectRequest,
  onDeleteRequest,
  onContextMenuTarget,
  onBeginTreeDrag,
}: {
  request: SavedRequest;
  selectedRequestId?: string;
  onSelectRequest: (request: SavedRequest) => void;
  onDeleteRequest: (request: SavedRequest) => void;
  onContextMenuTarget: (event: ReactMouseEvent, target: ContextMenuTarget) => void;
  onBeginTreeDrag: (payload: DragPayload, label: string, event: ReactMouseEvent) => void;
}) {
  const displayName = requestDisplayName(request);
  const requestUrl = request.url.trim();
  return (
    <div
      className={request.id === selectedRequestId ? "api-node is-selected" : "api-node"}
      onMouseDown={(event) => onBeginTreeDrag({ type: "request", id: request.id }, displayName, event)}
      onContextMenu={(event) => onContextMenuTarget(event, { type: "request", request })}
    >
      <button className="api-node__main" onClick={() => onSelectRequest(request)}>
        <span className="method-chip">{request.method}</span>
        <span className="api-node__text" title={requestUrl || displayName}>
          <strong>{displayName}</strong>
          {requestUrl && hasCustomRequestName(request) && <small>{requestUrl}</small>}
        </span>
      </button>
      <button
        className="api-node__delete"
        draggable={false}
        aria-label={`删除 ${displayName}`}
        title="删除 API"
        onClick={() => onDeleteRequest(request)}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function EmptyRail({
  icon: Icon,
  title,
  action,
  onAction,
}: {
  icon: typeof Folder;
  title: string;
  action: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-rail">
      <Icon size={28} />
      <p>{title}</p>
      <button className="button-secondary" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function CollectionCreateRow({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="collection-create-row">
      <Folder size={15} />
      <input
        autoFocus
        value={value}
        placeholder="集合名称"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      />
    </div>
  );
}

function RequestEditor({
  draft,
  requestTab,
  onRequestTabChange,
  onDraftChange,
  onRowChange,
  onSend,
  onExportCurl,
  isSending,
  isDirty,
  environment,
  response,
  scriptTab,
  onScriptTabChange,
  scriptLogs,
}: {
  draft: RequestDraft;
  requestTab: string;
  onRequestTabChange: (tab: string) => void;
  onDraftChange: (draft: RequestDraft) => void;
  onRowChange: (field: "params" | "headers", row: KeyValueRow) => void;
  onSend: () => void;
  onExportCurl: () => void;
  isSending: boolean;
  isDirty: boolean;
  environment?: Environment;
  response: HttpResponsePayload | null;
  scriptTab: string;
  onScriptTabChange: (tab: string) => void;
  scriptLogs: ScriptLogEntry[];
}) {
  return (
    <section className="request-editor">
      <div className="request-title">
        <div>
          <input
            value={draft.name}
            onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
            aria-label="请求名称"
          />
          <p>{isDirty ? "等待自动保存" : draft.id ? "已自动保存" : "新请求"} · 本地集合</p>
        </div>
        <button className="utility-button" onClick={onExportCurl}>
          <Archive size={15} />
          复制 cURL
        </button>
      </div>
      <div className="url-bar">
        <label className="method-select">
          <select
            value={draft.method}
            onChange={(event) => onDraftChange({ ...draft, method: event.target.value as HttpMethod })}
          >
            {methods.map((method) => (
              <option key={method}>{method}</option>
            ))}
          </select>
          <ChevronDown size={15} />
        </label>
        <input
          className="url-input"
          value={draft.url}
          onChange={(event) => onDraftChange({ ...draft, url: event.target.value })}
          placeholder="https://api.example.com/users"
        />
        <button className="button-primary send-button" disabled={isSending} onClick={onSend}>
          <Send size={16} />
          {isSending ? "发送中" : "发送"}
        </button>
      </div>
      <Tabs items={requestTabs} active={requestTab} onChange={onRequestTabChange} />
      <div className="request-pane">
        {requestTab === "Params" && <KeyValueTable rows={draft.params} field="params" onRowChange={onRowChange} />}
        {requestTab === "Headers" && <KeyValueTable rows={draft.headers} field="headers" onRowChange={onRowChange} />}
        {requestTab === "Body" && <BodyEditor draft={draft} onDraftChange={onDraftChange} />}
        {requestTab === "Mock" && <MockPanel draft={draft} onDraftChange={onDraftChange} />}
        {requestTab === "Scripts" && (
          <ScriptPanel
            draft={draft}
            onDraftChange={onDraftChange}
            activeTab={scriptTab}
            onTabChange={onScriptTabChange}
            logs={scriptLogs}
          />
        )}
        {requestTab === "Docs" && <RequestDocsPanel draft={draft} environment={environment} response={response} />}
      </div>
    </section>
  );
}

function KeyValueTable({
  rows,
  field,
  onRowChange,
}: {
  rows: KeyValueRow[];
  field: "params" | "headers";
  onRowChange: (field: "params" | "headers", row: KeyValueRow) => void;
}) {
  return (
    <div className="data-table">
      <div className="data-row data-row--head">
        <span>启用</span>
        <span>Key</span>
        <span>值</span>
        <span>描述</span>
      </div>
      {rows.map((row) => (
        <div className="data-row" key={row.id}>
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={(event) => onRowChange(field, { ...row, enabled: event.target.checked })}
          />
          <input value={row.key} onChange={(event) => onRowChange(field, { ...row, key: event.target.value })} />
          <input value={row.value} onChange={(event) => onRowChange(field, { ...row, value: event.target.value })} />
          <input
            value={row.description ?? ""}
            onChange={(event) => onRowChange(field, { ...row, description: event.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

function RequestDocsPanel({
  draft,
  environment,
  response,
}: {
  draft: RequestDraft;
  environment?: Environment;
  response: HttpResponsePayload | null;
}) {
  const enabledParams = draft.params.filter((row) => row.enabled && row.key.trim());
  const enabledHeaders = draft.headers.filter((row) => row.enabled && row.key.trim());
  const mock = draft.mockConfig;

  return (
    <div className="request-doc-panel">
      <section className="request-doc-hero">
        <div>
          <span>{draft.method}</span>
          <h3>{requestDisplayName(draft)}</h3>
          <p>{draft.url || "未设置 URL"}</p>
        </div>
        <button className="utility-button" onClick={() => navigator.clipboard?.writeText(draft.url || "")}>
          <Copy size={14} />
          复制 URL
        </button>
      </section>

      <section className="request-doc-grid">
        <DocSummaryItem label="环境" value={environment?.name ?? "未选择"} />
        <DocSummaryItem label="请求体" value={draft.bodyMode} />
        <DocSummaryItem label="超时" value={`${draft.timeoutMs} ms`} />
        <DocSummaryItem label="Mock" value={mock?.enabled ? `${mock.statusCode} · ${mock.delayMs} ms` : "未启用"} />
      </section>

      <DocRows title="参数" rows={enabledParams.map((row) => `${row.key}${row.value ? `=${row.value}` : ""}`)} />
      <DocRows
        title="请求头"
        rows={enabledHeaders.map((row) => `${row.key}: ${row.secret ? "••••••" : row.value}`)}
      />

      <section className="request-doc-block">
        <h4>请求体示例</h4>
        <pre>{draft.body.trim() || "无"}</pre>
      </section>

      <section className="request-doc-block">
        <h4>最近响应</h4>
        {response ? (
          <div className="request-doc-response">
            <span>{response.status} {response.statusText}</span>
            <span>{formatBytes(response.sizeBytes)}</span>
            <span>{response.durationMs} ms</span>
          </div>
        ) : (
          <p>暂无响应。</p>
        )}
      </section>
    </div>
  );
}

function DocSummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="request-doc-summary">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DocRows({ title, rows }: { title: string; rows: string[] }) {
  return (
    <section className="request-doc-block">
      <h4>{title}</h4>
      {rows.length === 0 ? <p>无</p> : rows.map((row) => <code key={row}>{row}</code>)}
    </section>
  );
}

function MockPanel({
  draft,
  onDraftChange,
}: {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
}) {
  const mock = draft.mockConfig ?? createDefaultMockConfig();
  const mockPath = buildMockPath(draft);

  const updateMock = (patch: Partial<MockConfig>) => {
    onDraftChange({ ...draft, mockConfig: { ...mock, ...patch } });
  };

  const updateHeader = (row: KeyValueRow) => {
    const rows = mock.headers.map((item) => (item.id === row.id ? row : item));
    const hasEmpty = rows.some((item) => !item.key && !item.value);
    updateMock({ headers: hasEmpty ? rows : [...rows, emptyRow("mock-header")] });
  };

  const copyMockPath = async () => {
    await navigator.clipboard?.writeText(mockPath);
  };

  return (
    <div className="mock-panel">
      <div className="mock-toolbar">
        <label className="mock-toggle">
          <input
            type="checkbox"
            checked={mock.enabled}
            onChange={(event) => updateMock({ enabled: event.target.checked })}
          />
          <span>{mock.enabled ? "Mock 已启用" : "启用 Mock"}</span>
        </label>
        <div className="mock-url">
          <span>{mockPath}</span>
          <button className="utility-button" onClick={copyMockPath}>
            <Clipboard size={14} />
            复制路径
          </button>
        </div>
      </div>
      <div className="mock-config-row">
        <label>
          状态码
          <input
            type="number"
            min={100}
            max={599}
            value={mock.statusCode}
            onChange={(event) => updateMock({ statusCode: Number(event.target.value) || 200 })}
          />
        </label>
        <label>
          延迟 ms
          <input
            type="number"
            min={0}
            value={mock.delayMs}
            onChange={(event) => updateMock({ delayMs: Number(event.target.value) || 0 })}
          />
        </label>
      </div>
      <div className="mock-section">
        <h3>响应头</h3>
        <KeyValueTable rows={mock.headers} field="headers" onRowChange={(_, row) => updateHeader(row)} />
      </div>
      <div className="mock-section mock-section--body">
        <h3>响应体</h3>
        <Editor
          path={`mock-body-${draft.id ?? "draft"}.json`}
          height="100%"
          language="json"
          theme="vs"
          value={mock.body}
          onChange={(value) => updateMock({ body: value ?? "" })}
          options={{
            minimap: { enabled: false },
            fontSize: 11,
            lineHeight: 18,
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
          }}
        />
      </div>
    </div>
  );
}

function BodyEditor({
  draft,
  onDraftChange,
}: {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
}) {
  const modes: BodyMode[] = ["none", "json", "form-data", "x-www-form-urlencoded", "raw", "xml", "binary", "graphql"];

  return (
    <div className="body-editor">
      <div className="body-editor__toolbar">
        <SegmentedControl
          items={modes}
          active={draft.bodyMode}
          onChange={(mode) => onDraftChange({ ...draft, bodyMode: mode as BodyMode })}
        />
        <button className="utility-button" onClick={() => onDraftChange({ ...draft, body: tryFormatJson(draft.body) })}>
          <Code2 size={15} />
          格式化
        </button>
      </div>
      {draft.bodyMode === "form-data" || draft.bodyMode === "x-www-form-urlencoded" ? (
        <KeyValueTable rows={[emptyRow("body")]} field="params" onRowChange={() => undefined} />
      ) : (
        <Editor
          path={`request-body-${draft.id ?? "draft"}.${draft.bodyMode === "xml" ? "xml" : draft.bodyMode === "graphql" ? "graphql" : "json"}`}
          height="100%"
          language={draft.bodyMode === "graphql" ? "graphql" : draft.bodyMode === "xml" ? "xml" : "json"}
          theme="vs"
          value={draft.body}
          onChange={(value) => onDraftChange({ ...draft, body: value ?? "" })}
          options={{
            minimap: { enabled: false },
            fontSize: 11,
            lineHeight: 18,
            scrollBeyondLastLine: false,
            padding: { top: 16, bottom: 16 },
          }}
        />
      )}
    </div>
  );
}

function ScriptPanel({
  draft,
  onDraftChange,
  activeTab,
  onTabChange,
  logs,
}: {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
  logs: ScriptLogEntry[];
}) {
  const scripts = draft.scripts ?? createDefaultScriptConfig();
  const updateScripts = (patch: Partial<ScriptConfig>) => {
    onDraftChange({ ...draft, scripts: { ...scripts, ...patch } });
  };

  return (
    <div className="script-grid">
      <div className="script-card script-card--editor">
        <div className="script-toolbar">
          <label className="mock-toggle">
            <input
              type="checkbox"
              checked={scripts.enabled}
              onChange={(event) => updateScripts({ enabled: event.target.checked })}
            />
            <span>{scripts.enabled ? "脚本已启用" : "启用脚本"}</span>
          </label>
          <SegmentedControl items={["pre", "post", "logs"]} active={activeTab} onChange={onTabChange} />
        </div>
        {activeTab === "pre" && (
          <Editor
            path={`pre-script-${draft.id ?? "draft"}.js`}
            height="100%"
            language="javascript"
            theme="vs"
            value={scripts.preRequest}
            onChange={(value) => updateScripts({ preRequest: value ?? "" })}
            options={{
              minimap: { enabled: false },
              fontSize: 11,
              lineHeight: 18,
              scrollBeyondLastLine: false,
              padding: { top: 12, bottom: 12 },
            }}
          />
        )}
        {activeTab === "post" && (
          <Editor
            path={`post-script-${draft.id ?? "draft"}.js`}
            height="100%"
            language="javascript"
            theme="vs"
            value={scripts.postResponse}
            onChange={(value) => updateScripts({ postResponse: value ?? "" })}
            options={{
              minimap: { enabled: false },
              fontSize: 11,
              lineHeight: 18,
              scrollBeyondLastLine: false,
              padding: { top: 12, bottom: 12 },
            }}
          />
        )}
        {activeTab === "logs" && <ScriptLogPanel logs={logs} />}
      </div>
    </div>
  );
}

function ScriptLogPanel({ logs }: { logs: ScriptLogEntry[] }) {
  if (logs.length === 0) {
    return (
      <div className="script-log-panel">
        <p>暂无脚本日志。发送请求后会显示 console 输出和断言结果。</p>
      </div>
    );
  }

  return (
    <div className="script-log-panel">
      {logs.map((log) => (
        <div className={`script-log-row script-log-row--${log.level}`} key={log.id}>
          <span>{log.time}</span>
          <strong>{log.level}</strong>
          <code>{log.message}</code>
        </div>
      ))}
    </div>
  );
}

function ResponseViewer({
  response,
  activeTab,
  onTabChange,
  error,
}: {
  response: HttpResponsePayload | null;
  activeTab: string;
  onTabChange: (tab: string) => void;
  error: string | null;
}) {
  const [formattedBody, setFormattedBody] = useState("");
  const contentType =
    response?.headers.find((row) => row.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  const isHtmlResponse = response ? contentType.includes("html") || looksLikeHtml(response.body) : false;
  const cookies = useMemo(() => (response ? parseSetCookieHeaders(response.headers) : []), [response]);

  useEffect(() => {
    let cancelled = false;

    if (!response) {
      setFormattedBody("");
      return;
    }

    if (!isHtmlResponse) {
      setFormattedBody(tryFormatJson(response.body));
      return;
    }

    setFormattedBody("正在格式化 HTML...");
    void formatHtmlPretty(response.body).then((value) => {
      if (!cancelled) {
        setFormattedBody(value);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isHtmlResponse, response]);

  return (
    <section className="response-viewer">
      <div className="response-header">
        <div className="response-heading">
          <strong>响应体</strong>
          <span>Response Viewer</span>
        </div>
        <div className="response-summary">
          <StatusMetric label="Status" value={response ? `${response.status} ${response.statusText}` : "-"} />
          <StatusMetric label="Time" value={response ? `${response.durationMs} ms` : "-"} />
          <StatusMetric label="Size" value={response ? formatBytes(response.sizeBytes) : "-"} />
          <StatusMetric label="URL" value={response?.url ?? "暂无响应"} wide />
        </div>
      </div>
      <Tabs items={responseTabs} active={activeTab} onChange={onTabChange} labels={responseTabLabels} />
      <div className="response-pane">
        {error ? (
          <div className="error-panel">
            <SquareTerminal size={28} />
            <h3>请求失败</h3>
            <p>{error}</p>
          </div>
        ) : !response ? (
          <PlaceholderPanel icon={SquareTerminal} title="暂无响应" text="发送一个请求后，可以在这里查看响应体、响应头、Cookie 和时间线。" />
        ) : activeTab === "Body" ? (
          <Editor
            path={`response-body-${response.url}-${response.status}.${isHtmlResponse ? "html" : "json"}`}
            height="100%"
            language={isHtmlResponse ? "html" : "json"}
            theme="vs"
            value={formattedBody}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 11,
              lineHeight: 18,
              wordWrap: "on",
              wrappingIndent: "indent",
              scrollBeyondLastLine: false,
            }}
          />
        ) : activeTab === "Headers" ? (
          <KeyValueTable rows={response.headers} field="headers" onRowChange={() => undefined} />
        ) : activeTab === "Raw" ? (
          <pre className="raw-response">{formatRawResponse(response)}</pre>
        ) : activeTab === "Cookies" ? (
          cookies.length > 0 ? (
            <CookieTable cookies={cookies} />
          ) : (
            <ResponseInfoPanel icon={Archive} title="暂无 Cookie" text="当前响应没有解析到 Set-Cookie。" />
          )
        ) : activeTab === "Tests" ? (
          <ResponseInfoPanel
            icon={Braces}
            title="暂无测试结果"
            text="当前请求还没有配置断言。配置状态码、字段或响应时间断言后，结果会显示在这里。"
          />
        ) : (
          <TimelineView response={response} />
        )}
      </div>
    </section>
  );
}

function formatRawResponse(response: HttpResponsePayload): string {
  const headerLines = response.headers.map((row) => `${row.key}: ${row.value}`).join("\n");
  return [`HTTP ${response.status} ${response.statusText}`, headerLines, "", response.body].join("\n");
}

function parseSetCookieHeaders(headers: KeyValueRow[]): ResponseCookie[] {
  return headers
    .filter((row) => row.key.toLowerCase() === "set-cookie" && row.value.trim())
    .flatMap((row) => splitCombinedSetCookie(row.value))
    .map((value, index) => parseSetCookie(value, index));
}

function splitCombinedSetCookie(value: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  let inExpires = false;
  const lower = value.toLowerCase();

  for (let index = 0; index < value.length; index += 1) {
    if (lower.slice(index, index + 8) === "expires=") {
      inExpires = true;
    }

    if (inExpires && value[index] === ";") {
      inExpires = false;
    }

    if (!inExpires && value[index] === "," && /\s*[^=;,\s]+=/.test(value.slice(index + 1, index + 80))) {
      cookies.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  cookies.push(value.slice(start).trim());
  return cookies.filter(Boolean);
}

function parseSetCookie(value: string, index: number): ResponseCookie {
  const segments = value.split(";").map((segment) => segment.trim());
  const [nameValue = ""] = segments;
  const separatorIndex = nameValue.indexOf("=");
  const cookie: ResponseCookie = {
    id: `cookie-${index}-${nameValue}`,
    name: separatorIndex >= 0 ? nameValue.slice(0, separatorIndex) : nameValue,
    value: separatorIndex >= 0 ? nameValue.slice(separatorIndex + 1) : "",
    domain: "",
    path: "",
    expires: "",
    httpOnly: false,
    secure: false,
    sameSite: "",
  };

  for (const segment of segments.slice(1)) {
    const [rawKey, ...rawValue] = segment.split("=");
    const key = rawKey.trim().toLowerCase();
    const attrValue = rawValue.join("=").trim();

    if (key === "domain") cookie.domain = attrValue;
    if (key === "path") cookie.path = attrValue;
    if (key === "expires" || key === "max-age") cookie.expires = attrValue;
    if (key === "httponly") cookie.httpOnly = true;
    if (key === "secure") cookie.secure = true;
    if (key === "samesite") cookie.sameSite = attrValue;
  }

  return cookie;
}

function CookieTable({ cookies }: { cookies: ResponseCookie[] }) {
  return (
    <div className="cookie-table">
      <div className="cookie-row cookie-row--head">
        <span>名称</span>
        <span>值</span>
        <span>Domain</span>
        <span>Path</span>
        <span>Expires / Max-Age</span>
        <span>属性</span>
      </div>
      {cookies.map((cookie) => (
        <div className="cookie-row" key={cookie.id}>
          <span title={cookie.name}>{cookie.name}</span>
          <span title={cookie.value}>{cookie.value}</span>
          <span title={cookie.domain}>{cookie.domain || "-"}</span>
          <span title={cookie.path}>{cookie.path || "-"}</span>
          <span title={cookie.expires}>{cookie.expires || "-"}</span>
          <span className="cookie-flags">
            {cookie.httpOnly && <em>HttpOnly</em>}
            {cookie.secure && <em>Secure</em>}
            {cookie.sameSite && <em>SameSite={cookie.sameSite}</em>}
            {!cookie.httpOnly && !cookie.secure && !cookie.sameSite && "-"}
          </span>
        </div>
      ))}
    </div>
  );
}

function TimelineView({ response }: { response: HttpResponsePayload }) {
  const rows = [
    ["DNS", "-"],
    ["TCP", "-"],
    ["TLS", "-"],
    ["TTFB", `${response.durationMs} ms`],
    ["Download", `${formatBytes(response.sizeBytes)}`],
  ];

  return (
    <div className="timeline-view">
      {rows.map(([label, value]) => (
        <div className="timeline-row" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function ResponseInfoPanel({ icon: Icon, title, text }: { icon: typeof Folder; title: string; text: string }) {
  return (
    <div className="placeholder-panel">
      <Icon size={30} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function RightPanel({
  activeTab,
  onTabChange,
  environment,
  logs,
  logFilter,
  onLogFilterChange,
  onRefreshLogs,
  onClearLogs,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  environment?: Environment;
  logs: LogEntry[];
  logFilter: string;
  onLogFilterChange: (filter: string) => void;
  onRefreshLogs: () => Promise<LogEntry[]>;
  onClearLogs: () => Promise<void>;
}) {
  return (
    <aside className="right-panel">
      <Tabs items={rightTabs} active={activeTab} onChange={onTabChange} compact />
      {activeTab === "Variables" && (
        <div className="assistant-panel">
          <h2>{environment?.name ?? "未选择环境"}</h2>
          {environment?.variables.map((variable) => (
            <div className="variable-row" key={variable.id}>
              <span>{`{{${variable.key}}}`}</span>
              <strong>{variable.secret ? "••••••" : variable.value}</strong>
            </div>
          ))}
        </div>
      )}
      {activeTab === "Logs" && (
        <LogPanel
          logs={logs}
          filter={logFilter}
          onFilterChange={onLogFilterChange}
          onRefresh={onRefreshLogs}
          onClear={onClearLogs}
        />
      )}
    </aside>
  );
}

function LogPanel({
  logs,
  filter,
  onFilterChange,
  onRefresh,
  onClear,
}: {
  logs: LogEntry[];
  filter: string;
  onFilterChange: (filter: string) => void;
  onRefresh: () => Promise<LogEntry[]>;
  onClear: () => Promise<void>;
}) {
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const filters = [
    { id: "all", label: "全部" },
    { id: "request", label: "请求" },
    { id: "response", label: "响应" },
    { id: "script", label: "脚本" },
    { id: "error", label: "错误" },
  ];
  const visibleLogs = logs
    .filter((log) => {
      if (filter === "all") return true;
      if (filter === "script") {
        return log.stage === "pre-script" || log.stage === "post-script" || log.stage === "script-log" || log.level.startsWith("assert");
      }
      if (filter === "error") return log.level === "error" || log.level === "assert-fail";
      return log.stage === filter;
    })
    .slice()
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());

  useEffect(() => {
    const node = logListRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [visibleLogs.length, filter]);

  return (
    <div className="log-panel">
      <div className="log-panel__toolbar">
        <div className="log-panel__filters">
          {filters.map((item) => (
            <button
              className={filter === item.id ? "is-active" : ""}
              key={item.id}
              onClick={() => onFilterChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="log-panel__actions">
          <button className="utility-button" onClick={() => void onRefresh()}>
            刷新
          </button>
          <button className="utility-button" onClick={() => void onClear()}>
            清空
          </button>
        </div>
      </div>
      <div className="log-list" ref={logListRef}>
        {visibleLogs.length === 0 ? (
          <PlaceholderPanel icon={SquareTerminal} title="暂无日志" text="发送请求或执行脚本后，整体日志会显示在这里。" />
        ) : (
          visibleLogs.map((log) => {
            const expanded = expandedLogId === log.id;
            return (
              <button
                className={`log-entry log-entry--${log.level}`}
                key={log.id}
                onClick={() => setExpandedLogId(expanded ? null : log.id)}
              >
                <span className="log-entry__meta">
                  <em>{formatLogTime(log.createdAt)}</em>
                  <strong>{formatLogStage(log.stage)}</strong>
                  {log.status ? <b>{log.status}</b> : null}
                </span>
                <span className="log-entry__message">{log.message}</span>
                {(log.method || log.url) && (
                  <span className="log-entry__target">
                    {log.method ? `${log.method} ` : ""}
                    {log.url}
                  </span>
                )}
                {expanded && (
                  <span className="log-entry__detail">
                    {log.requestBody && (
                      <>
                        <small>请求体</small>
                        <code>{log.requestBody}</code>
                      </>
                    )}
                    {log.responseBody && (
                      <>
                        <small>响应体</small>
                        <code>{log.responseBody}</code>
                      </>
                    )}
                    {!log.requestBody && !log.responseBody && <code>{log.message}</code>}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function formatLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function formatLogStage(stage: LogStage): string {
  const labels: Record<LogStage, string> = {
    request: "请求",
    response: "响应",
    mock: "Mock",
    "pre-script": "请求前",
    "post-script": "响应后",
    "script-log": "脚本",
    error: "错误",
  };
  return labels[stage] ?? stage;
}

function SettingsPanel({
  autoSaveIntervalMs,
  onAutoSaveIntervalChange,
}: {
  autoSaveIntervalMs: number;
  onAutoSaveIntervalChange: (value: number) => void;
}) {
  return (
    <main className="settings-page">
      <section className="settings-panel">
        <div>
          <h2>设置</h2>
          <p>调整 Holaman 的本地工作流偏好。</p>
        </div>
        <div className="settings-section">
          <div>
            <h3>自动保存频率</h3>
            <p>请求草稿会按固定频率写入本地 SQLite，主工作台不再显示手动保存按钮。</p>
          </div>
          <div className="settings-options" role="radiogroup" aria-label="自动保存频率">
            {autoSaveIntervalOptions.map((value) => (
              <button
                className={value === autoSaveIntervalMs ? "is-active" : ""}
                key={value}
                onClick={() => onAutoSaveIntervalChange(value)}
                role="radio"
                aria-checked={value === autoSaveIntervalMs}
              >
                {formatAutoSaveInterval(value)}
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function GuidePanel() {
  return (
    <main className="guide-page">
      <section className="guide-panel">
        <div className="guide-hero">
          <div>
            <span>Holaman Guide</span>
            <h2>工作台脚本使用文档</h2>
            <p>脚本只作用于当前请求，用来在发送前整理请求，在响应后提取数据、写入环境变量和做轻量断言。</p>
          </div>
        </div>

        <div className="guide-grid">
          <article className="guide-section">
            <h3>执行顺序</h3>
            <ol>
              <li>点击发送后，先执行“请求前脚本”。</li>
              <li>脚本可以修改当前请求的 URL、参数、请求头和请求体。</li>
              <li>Holaman 使用修改后的请求发送真实请求，或返回当前请求的 Mock 响应。</li>
              <li>收到响应后执行“响应后脚本”。</li>
              <li>日志和断言结果显示在脚本 tab 的“日志”区。</li>
            </ol>
          </article>

          <article className="guide-section">
            <h3>安全边界</h3>
            <p>脚本运行在前端受限上下文中，不开放文件系统、Tauri API、外部依赖和网络请求。默认超时时间为 1000ms。</p>
          </article>
        </div>

        <article className="guide-section">
          <h3>请求前脚本</h3>
          <p>适合补充公共 Header、追加时间戳参数、动态生成 JSON Body。</p>
          <pre>{`request.headers.set("X-Request-Id", uuid())
request.params.set("ts", timestamp())
request.bodyMode.set("json")
request.body.set({
  name: "Holaman",
  createdAt: timestamp()
})`}</pre>
        </article>

        <article className="guide-section">
          <h3>响应后脚本</h3>
          <p>适合解析 JSON、保存 token 到当前环境、验证状态码和响应内容。</p>
          <pre>{`const data = response.json()

if (data.access_token) {
  env.set("token", data.access_token)
}

expect(response.status).toBe(200)
expect(response.text()).toContain("success")
expect(response.time).toBeLessThan(1000)`}</pre>
        </article>

        <article className="guide-section guide-section--api">
          <h3>request 对象</h3>
          <p>只在“请求前脚本”中修改才会影响本次发送；在“响应后脚本”中读取也可用，但修改不会重新发送请求。</p>
          <table>
            <thead>
              <tr>
                <th>成员</th>
                <th>参数</th>
                <th>返回值</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>request.url</code></td>
                <td>赋值字符串</td>
                <td>string</td>
                <td>当前请求 URL。可直接读取或赋值，例如 <code>request.url = "https://api.example.com/users"</code>。</td>
              </tr>
              <tr>
                <td><code>request.method</code></td>
                <td>赋值 HTTP 方法</td>
                <td>string</td>
                <td>当前请求方法。支持 <code>GET</code>、<code>POST</code>、<code>PUT</code>、<code>PATCH</code>、<code>DELETE</code>、<code>HEAD</code>、<code>OPTIONS</code>。</td>
              </tr>
              <tr>
                <td><code>request.params.get(key)</code></td>
                <td><code>key: string</code></td>
                <td>string | undefined</td>
                <td>读取启用状态的 Query 参数，key 不区分大小写。</td>
              </tr>
              <tr>
                <td><code>request.params.set(key, value)</code></td>
                <td><code>key: string</code><br /><code>value: unknown</code></td>
                <td>void</td>
                <td>新增或更新 Query 参数。value 会转为字符串，并自动启用该参数。</td>
              </tr>
              <tr>
                <td><code>request.params.delete(key)</code></td>
                <td><code>key: string</code></td>
                <td>void</td>
                <td>不物理删除行，而是禁用对应 Query 参数。</td>
              </tr>
              <tr>
                <td><code>request.headers.get(key)</code></td>
                <td><code>key: string</code></td>
                <td>string | undefined</td>
                <td>读取启用状态的请求头，key 不区分大小写。</td>
              </tr>
              <tr>
                <td><code>request.headers.set(key, value)</code></td>
                <td><code>key: string</code><br /><code>value: unknown</code></td>
                <td>void</td>
                <td>新增或更新请求头。常用于 token、trace id、content type。</td>
              </tr>
              <tr>
                <td><code>request.headers.delete(key)</code></td>
                <td><code>key: string</code></td>
                <td>void</td>
                <td>禁用指定请求头，本次发送不会带上它。</td>
              </tr>
              <tr>
                <td><code>request.body.get()</code></td>
                <td>无</td>
                <td>string</td>
                <td>读取当前请求体原始文本。</td>
              </tr>
              <tr>
                <td><code>request.body.set(value)</code></td>
                <td><code>value: string | object</code></td>
                <td>void</td>
                <td>设置请求体。传对象时会自动格式化为 JSON 字符串。</td>
              </tr>
              <tr>
                <td><code>request.bodyMode.get()</code></td>
                <td>无</td>
                <td>string</td>
                <td>读取请求体模式，例如 <code>none</code>、<code>json</code>、<code>raw</code>、<code>form</code>、<code>xml</code>、<code>graphql</code>。</td>
              </tr>
              <tr>
                <td><code>request.bodyMode.set(mode)</code></td>
                <td><code>mode: string</code></td>
                <td>void</td>
                <td>设置请求体模式。发送 JSON 前通常配合 <code>request.body.set(...)</code> 使用。</td>
              </tr>
            </tbody>
          </table>
        </article>

        <article className="guide-section guide-section--api">
          <h3>response 对象</h3>
          <p>只在“响应后脚本”中有真实值。请求前脚本阶段没有响应对象。</p>
          <table>
            <thead>
              <tr>
                <th>成员</th>
                <th>参数</th>
                <th>返回值</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>response.status</code></td>
                <td>无</td>
                <td>number</td>
                <td>HTTP 状态码，例如 <code>200</code>、<code>404</code>、<code>500</code>。</td>
              </tr>
              <tr>
                <td><code>response.time</code></td>
                <td>无</td>
                <td>number</td>
                <td>请求耗时，单位毫秒，可用于性能断言。</td>
              </tr>
              <tr>
                <td><code>response.headers.get(key)</code></td>
                <td><code>key: string</code></td>
                <td>string | undefined</td>
                <td>读取响应头，key 不区分大小写，例如 <code>response.headers.get("content-type")</code>。</td>
              </tr>
              <tr>
                <td><code>response.text()</code></td>
                <td>无</td>
                <td>string</td>
                <td>返回响应体原始文本。HTML、XML、纯文本都用它读取。</td>
              </tr>
              <tr>
                <td><code>response.json()</code></td>
                <td>无</td>
                <td>any</td>
                <td>把响应体按 JSON 解析。响应不是合法 JSON 时会抛错并写入脚本日志。</td>
              </tr>
            </tbody>
          </table>
        </article>

        <article className="guide-section guide-section--api">
          <h3>env、expect、console 与工具函数</h3>
          <p><code>env.set</code> 会写入当前选择的环境；如果没有选择环境，会提示错误并停止当前脚本。</p>
          <table>
            <thead>
              <tr>
                <th>方法</th>
                <th>参数</th>
                <th>返回值</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>env.get(key)</code></td>
                <td><code>key: string</code></td>
                <td>string | undefined</td>
                <td>读取当前环境中启用的变量，例如 <code>env.get("token")</code>。</td>
              </tr>
              <tr>
                <td><code>env.set(key, value)</code></td>
                <td><code>key: string</code><br /><code>value: unknown</code></td>
                <td>void</td>
                <td>新增或更新当前环境变量。value 会转为字符串；变量名包含 token、secret、password、key 时会标记为敏感。</td>
              </tr>
              <tr>
                <td><code>env.delete(key)</code></td>
                <td><code>key: string</code></td>
                <td>void</td>
                <td>从当前环境中移除变量。</td>
              </tr>
              <tr>
                <td><code>expect(value).toBe(expected)</code></td>
                <td><code>value: unknown</code><br /><code>expected: unknown</code></td>
                <td>void</td>
                <td>使用严格相等比较。失败会记录 failed 并抛出断言错误。</td>
              </tr>
              <tr>
                <td><code>expect(value).toContain(expected)</code></td>
                <td><code>value: unknown</code><br /><code>expected: unknown</code></td>
                <td>void</td>
                <td>把两边转成字符串后检查包含关系，适合检查响应文本。</td>
              </tr>
              <tr>
                <td><code>expect(value).toBeLessThan(expected)</code></td>
                <td><code>value: number</code><br /><code>expected: number</code></td>
                <td>void</td>
                <td>把 value 转成数字后比较是否小于 expected，适合检查响应耗时。</td>
              </tr>
              <tr>
                <td><code>console.log/warn/error(...values)</code></td>
                <td><code>...values: unknown[]</code></td>
                <td>void</td>
                <td>输出脚本日志。对象会序列化为 JSON 文本显示。</td>
              </tr>
              <tr>
                <td><code>uuid()</code></td>
                <td>无</td>
                <td>string</td>
                <td>生成随机 UUID，适合请求追踪 ID 或幂等键。</td>
              </tr>
              <tr>
                <td><code>timestamp()</code></td>
                <td>无</td>
                <td>number</td>
                <td>返回当前 Unix 毫秒时间戳。</td>
              </tr>
            </tbody>
          </table>
        </article>

        <div className="guide-grid guide-grid--three">
          <article className="guide-section">
            <h3>示例：追加鉴权</h3>
            <pre>{`const token = env.get("token")
if (token) {
  request.headers.set("Authorization", "Bearer " + token)
}`}</pre>
          </article>

          <article className="guide-section">
            <h3>示例：保存 token</h3>
            <pre>{`const data = response.json()
env.set("token", data.token)`}</pre>
          </article>

          <article className="guide-section">
            <h3>示例：调试输出</h3>
            <pre>{`console.log("status", response.status)
console.warn("time", response.time)`}</pre>
          </article>
        </div>
      </section>
    </main>
  );
}

function ModuleSkeleton({ module }: { module: string }) {
  const iconMap: Record<string, typeof Folder> = {
    Collections: Folder,
    Environments: Variable,
    Settings: Settings,
  };
  const Icon = iconMap[module] ?? Folder;

  return (
    <main className="module-skeleton">
      <section className="module-hero">
        <Icon size={42} />
        <h2>{t(module)}</h2>
        <p>
          这个页面已经接入桌面壳，作为第一阶段功能骨架。工作台闭环稳定后，它会继续连接到 Rust Core 的真实能力。
        </p>
      </section>
    </main>
  );
}

function SegmentedControl({
  items,
  active,
  onChange,
}: {
  items: string[];
  active: string;
  onChange: (item: string) => void;
}) {
  return (
    <div className="segmented-control">
      {items.map((item) => (
        <button key={item} className={active === item ? "is-active" : ""} onClick={() => onChange(item)}>
          {t(item)}
        </button>
      ))}
    </div>
  );
}

function Tabs({
  items,
  active,
  onChange,
  compact,
  labels,
}: {
  items: string[];
  active: string;
  onChange: (item: string) => void;
  compact?: boolean;
  labels?: Record<string, string>;
}) {
  return (
    <div className={compact ? "tabs tabs--compact" : "tabs"}>
      {items.map((item) => (
        <button key={item} className={active === item ? "is-active" : ""} onClick={() => onChange(item)}>
          {labels?.[item] ?? t(item)}
        </button>
      ))}
    </div>
  );
}

function StatusMetric({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "status-metric status-metric--wide" : "status-metric"}>
      <span>{t(label)}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PlaceholderPanel({ icon: Icon, title, text }: { icon: typeof Folder; title: string; text: string }) {
  return (
    <div className="placeholder-panel">
      <Icon size={30} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

export default App;

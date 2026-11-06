// ComfyUI 节点的数据层:连接设置、工作流解析、参数元数据、执行与停止。
// 这里不碰 React,UI 全部在 ui.tsx。
import type { CanvasNodeContext, CanvasNodeData } from "@infinite-canvas/plugin-sdk";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8188";
export const LIBRARY_KEY = "library.v1";
export const SHARED_SETTINGS_KEY = "settings.v1";
const LOCAL_PROXY = "http://127.0.0.1:23210";
const STORAGE_KEY_PREFIX = "node:";
const POLL_INTERVAL_MS = 1500;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

export type Override = string | number | boolean;

export type ComfyConfig = {
    prompt: string;
    negativePrompt: string;
    workflowId: string;
    workflowName: string;
    // 节点内缓存一份正文:库条目被删或读不到时仍能跑
    workflow: string;
    // 手动挑选的参考图(画布图片节点 id),按顺序填给工作流里的 LoadImage
    references: string[];
    // 打开后不再自动使用上游连线的图片
    ignoreUpstream?: boolean;
    overrides: Record<string, Override>;
};

export const DEFAULT_CONFIG: ComfyConfig = { prompt: "", negativePrompt: "", workflowId: "", workflowName: "", workflow: "", references: [], ignoreUpstream: false, overrides: {} };

export type WorkflowEntry = { id: string; name: string; workflow: string; updatedAt: number; visibleParams?: string[] };

export type ApiNode = { class_type?: string; inputs?: Record<string, unknown> };
export type ApiWorkflow = Record<string, ApiNode>;
export type ComfyParam = { nodeId: string; classType: string; input: string; control: "text" | "number" | "boolean"; value: Override };
export type NodeInfo = { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } };
type ComfyOutput = { images?: Array<{ filename: string; subfolder: string; type: string }> };
type SharedSettings = { baseUrl?: string; proxyUrl?: string };
export type Connection = { baseUrl: string; proxyUrl: string };

/** 工具栏与面板都要触发运行/停止,控制器按节点 id 存在模块级。 */
export const runningRuns = new Map<string, AbortController>();
export const configCache = new Map<string, ComfyConfig>();
const objectInfoCache = new Map<string, NodeInfo>();
let detectedProxy: string | null = null;

export function storageKey(nodeId: string) {
    return `${STORAGE_KEY_PREFIX}${nodeId}`;
}

function trimSlash(value: string) {
    return value.trim().replace(/\/+$/, "");
}

export function targetUrl(connection: Connection, path: string) {
    const base = trimSlash(connection.baseUrl) || DEFAULT_BASE_URL;
    const url = `${base}${path}`;
    const proxy = trimSlash(connection.proxyUrl);
    return proxy ? `${proxy}/${url}` : url;
}

async function detectLocalProxy() {
    if (detectedProxy !== null) return detectedProxy;
    try {
        const response = await fetch(`${LOCAL_PROXY}/`, { cache: "no-store" });
        const data = response.ok ? ((await response.json()) as { proxy?: string } | null) : null;
        if (data?.proxy) detectedProxy = LOCAL_PROXY;
        return data?.proxy ? LOCAL_PROXY : "";
    } catch {
        return "";
    }
}

export async function resolveConnection(ctx: CanvasNodeContext): Promise<Connection> {
    const shared = await ctx.storage.get<SharedSettings>(SHARED_SETTINGS_KEY).catch(() => null);
    const baseUrl = shared?.baseUrl?.trim() || DEFAULT_BASE_URL;
    const configured = shared?.proxyUrl?.trim() || "";
    return { baseUrl, proxyUrl: configured || (await detectLocalProxy()) };
}

export function parseWorkflow(text: string): ApiWorkflow {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("工作流不是合法 JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工作流必须是 JSON 对象(API 格式)");
    const workflow = parsed as ApiWorkflow;
    if (!Object.keys(workflow).length) throw new Error("工作流是空对象");
    return workflow;
}

export function collectParams(workflow: ApiWorkflow): ComfyParam[] {
    const params: ComfyParam[] = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
        const inputs = node?.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        const classType = node?.class_type || "";
        for (const [input, value] of Object.entries(inputs)) {
            if (Array.isArray(value)) continue;
            if (typeof value === "string") params.push({ nodeId, classType, input, control: "text", value });
            else if (typeof value === "number") params.push({ nodeId, classType, input, control: "number", value });
            else if (typeof value === "boolean") params.push({ nodeId, classType, input, control: "boolean", value });
        }
    }
    return params;
}

/** 文本编码节点按节点 id 排序:第一个正向,第二个反向。只算真正会执行的节点。 */
export function textTargets(workflow: ApiWorkflow) {
    const active = activeNodeIds(workflow);
    return Object.keys(workflow)
        .filter((nodeId) => active.has(nodeId) && /cliptextencode/i.test(workflow[nodeId]?.class_type || "") && typeof workflow[nodeId]?.inputs?.text === "string")
        .sort((a, b) => Number(a) - Number(b));
}

/** 工作流里的 LoadImage 节点,按节点 id 排序:参考图按顺序依次填入。只算真正会执行的节点。 */
function imageTargets(workflow: ApiWorkflow) {
    const active = activeNodeIds(workflow);
    return Object.keys(workflow)
        .filter((nodeId) => active.has(nodeId) && /loadimage/i.test(workflow[nodeId]?.class_type || "") && typeof workflow[nodeId]?.inputs?.image === "string")
        .sort((a, b) => Number(a) - Number(b));
}

export function isImageUrl(url: string) {
    // 画布上的图片恢复后常是 blob: 地址,不能只认 data:/http
    return /^(data:image\/|https?:\/\/|blob:)/.test(url);
}

/** 取节点上可用的图片地址:优先 content,批量图片则在 images[] 里找。 */
export function imageSourceOf(node: CanvasNodeData) {
    const metadata = (node.metadata || {}) as { content?: string; images?: Array<{ content?: string }> };
    const direct = metadata.content || "";
    if (isImageUrl(direct)) return direct;
    for (const item of metadata.images || []) {
        const content = item?.content || "";
        if (isImageUrl(content)) return content;
    }
    return "";
}

function upstreamImages(ctx: CanvasNodeContext) {
    return ctx.getUpstream().map(imageSourceOf).filter(Boolean);
}

/** 手动作选的参考图与上游文本。文本节点可当提示词来源(例如宿主「反推提示词」生成的文本)。 */
function upstreamText(ctx: CanvasNodeContext) {
    return ctx
        .getUpstream()
        .map((node) => node.metadata?.content || "")
        .filter((text) => text && !isImageUrl(text))
        .join("\n")
        .trim();
}

/** 参考图:上游连线的图优先,其次才是手动挑的;去重后按顺序填给 LoadImage。 */
function referenceImages(ctx: CanvasNodeContext, config: ComfyConfig) {
    const upstream = config.ignoreUpstream ? [] : upstreamImages(ctx);
    const manual = config.references
        .map((id) => {
            const node = ctx.getNode(id);
            return node ? imageSourceOf(node) : "";
        })
        .filter(Boolean);
    const merged = [...upstream];
    for (const url of manual) if (!merged.includes(url)) merged.push(url);
    return merged;
}

function applyParams(workflow: ApiWorkflow, overrides: Record<string, Override>) {
    for (const [key, value] of Object.entries(overrides)) {
        const dot = key.indexOf(".");
        if (dot <= 0) continue;
        const nodeId = key.slice(0, dot);
        const input = key.slice(dot + 1);
        const node = workflow[nodeId];
        if (!node?.inputs || !(input in node.inputs)) continue;
        if (Array.isArray(node.inputs[input])) continue;
        node.inputs[input] = value;
    }
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}

function sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

const OUTPUT_PATTERN = /saveimage|previewimage|savevideo|videocombine|savetext/i;

/**
 * 真正会执行的节点:从输出节点沿连线回溯能走到的那些。
 * 没接进输出的分支 ComfyUI 不会跑到,参数卡也就不该列它。
 */
export function activeNodeIds(workflow: ApiWorkflow) {
    const ids = Object.keys(workflow);
    const outputs = ids.filter((id) => OUTPUT_PATTERN.test(workflow[id]?.class_type || ""));
    // 认不出输出节点时退化成「没有下游的节点」,再不行就不筛
    const terminals = outputs.length
        ? outputs
        : ids.filter((id) => {
              const referenced = ids.some((other) => Object.values(workflow[other]?.inputs || {}).some((value) => Array.isArray(value) && value[0] === id));
              return !referenced;
          });
    if (!terminals.length) return new Set(ids);

    const seen = new Set<string>();
    const stack = [...terminals];
    while (stack.length) {
        const id = stack.pop() as string;
        if (seen.has(id) || !workflow[id]) continue;
        seen.add(id);
        for (const value of Object.values(workflow[id].inputs || {})) {
            if (Array.isArray(value) && typeof value[0] === "string") stack.push(value[0]);
        }
    }
    return seen;
}

/** 每个 loader 节点里指向磁盘文件的输入名;其余 *Loader 节点按 *_name 兜底识别。 */
const FILE_INPUTS: Record<string, string[]> = {
    CheckpointLoaderSimple: ["ckpt_name"],
    CheckpointLoader: ["ckpt_name"],
    LoraLoader: ["lora_name"],
    LoraLoaderModelOnly: ["lora_name"],
    VAELoader: ["vae_name"],
    UNETLoader: ["unet_name"],
    CLIPLoader: ["clip_name"],
    DualCLIPLoader: ["clip_name1", "clip_name2"],
    TripleCLIPLoader: ["clip_name1", "clip_name2", "clip_name3"],
    ControlNetLoader: ["control_net_name"],
    UpscaleModelLoader: ["model_name"],
    StyleModelLoader: ["style_model_name"],
    GLIGENLoader: ["gligen_name"],
    LoadImage: ["image"],
};

function fileInputsOf(classType: string, inputs: Record<string, unknown>) {
    const known = FILE_INPUTS[classType];
    if (known) return known;
    if (classType.endsWith("Loader")) return Object.keys(inputs).filter((name) => name.endsWith("_name"));
    return [];
}

/**
 * 执行前检查:工作流引用的模型/图片在 ComfyUI 那台机器上是否存在。
 * 拿不到 object_info(比如服务没开)时直接跳过,不阻塞运行。
 */
async function preflightWorkflow(ctx: CanvasNodeContext, workflow: ApiWorkflow, hasReference: boolean, signal: AbortSignal) {
    const checks: Array<{ nodeId: string; classType: string; input: string; value: string }> = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
        const classType = node?.class_type || "";
        const inputs = (node?.inputs || {}) as Record<string, unknown>;
        for (const input of fileInputsOf(classType, inputs)) {
            const value = inputs[input];
            if (typeof value !== "string" || !value) continue;
            // 参考图会被上传覆盖,不用检查工作流原来的图片
            if (classType === "LoadImage" && hasReference) continue;
            checks.push({ nodeId, classType, input, value });
        }
    }
    if (!checks.length) return;

    const classes = Array.from(new Set(checks.map((check) => check.classType)));
    const infos = await loadClassInfos(ctx, classes, signal);
    const missing: string[] = [];
    for (const check of checks) {
        const info = infos[check.classType];
        const spec = info?.input?.required?.[check.input] ?? info?.input?.optional?.[check.input];
        const options = Array.isArray(spec) ? spec[0] : undefined;
        if (!Array.isArray(options)) continue; // 没有候选列表就没法判断
        if (!(options as unknown[]).includes(check.value)) missing.push(`${check.value}（${check.classType}.${check.input}）`);
    }
    if (!missing.length) return;

    const preview = missing.slice(0, 3).join("、");
    const more = missing.length > 3 ? ` 等 ${missing.length} 个` : "";
    throw new Error(`缺少文件：${preview}${more}；请确认它们已在 ComfyUI 的 models/input 目录里`);
}

function forbiddenHint(status: number) {
    return status === 403 ? "ComfyUI 拒绝了跨域请求(403):启动时加 --enable-cors-header,或在「配置 → ComfyUI」里填本地代理" : "";
}

function requestError(error: unknown, connection: Connection) {
    if (error instanceof DOMException && error.name === "AbortError") return error;
    if (error instanceof TypeError) {
        const hint = connection.proxyUrl ? "仍失败请确认 canvas-proxy 已启动" : "若 ComfyUI 没开 CORS,请在配置里填代理地址";
        return new Error(`连不上 ComfyUI(${trimSlash(connection.baseUrl) || DEFAULT_BASE_URL})，${hint}`);
    }
    return error instanceof Error ? error : new Error(String(error));
}

async function uploadReference(connection: Connection, dataUrl: string, signal: AbortSignal) {
    const blob = await (await fetch(dataUrl)).blob();
    const form = new FormData();
    form.append("image", blob, "canvas-reference.png");
    form.append("overwrite", "true");
    const response = await fetch(targetUrl(connection, "/upload/image"), { method: "POST", body: form, signal });
    if (!response.ok) throw new Error(forbiddenHint(response.status) || `上传参考图失败(HTTP ${response.status})`);
    const data = (await response.json()) as { name?: string; subfolder?: string };
    if (!data?.name) throw new Error("上传参考图失败:ComfyUI 没有返回文件名");
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

type NodeErrorEntry = { errors?: Array<{ message?: string; details?: string }>; class_type?: string };

async function queuePrompt(connection: Connection, workflow: ApiWorkflow, signal: AbortSignal) {
    const response = await fetch(targetUrl(connection, "/prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: `canvas-${Math.random().toString(36).slice(2)}` }),
        signal,
    });
    const data = (await response.json().catch(() => null)) as { prompt_id?: string; error?: { message?: string }; node_errors?: Record<string, NodeErrorEntry> } | null;
    if (!response.ok) throw new Error(forbiddenHint(response.status) || data?.error?.message || `提交工作流失败(HTTP ${response.status})`);
    const nodeErrors = data?.node_errors || {};
    const failed = Object.entries(nodeErrors).find(([, entry]) => entry?.errors?.length);
    if (failed) {
        const [nodeId, entry] = failed;
        const detail = entry.errors?.[0]?.message || entry.errors?.[0]?.details || "";
        throw new Error(`节点 ${nodeId}${entry.class_type ? `(${entry.class_type})` : ""} 报错${detail ? `：${detail}` : ""}`);
    }
    if (!data?.prompt_id) throw new Error(data?.error?.message || "ComfyUI 没有返回 prompt_id");
    return data.prompt_id;
}

async function waitForOutputs(connection: Connection, promptId: string, signal: AbortSignal) {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
        if (Date.now() > deadline) throw new Error("等待 ComfyUI 出图超时");
        const response = await fetch(targetUrl(connection, `/history/${promptId}`), { signal });
        if (!response.ok) throw new Error(`查询执行结果失败(HTTP ${response.status})`);
        const history = (await response.json()) as Record<string, { outputs?: Record<string, ComfyOutput>; status?: { status_str?: string } }>;
        const entry = history?.[promptId];
        if (entry) {
            if (entry.status?.status_str === "error") throw new Error("ComfyUI 执行失败,请看 ComfyUI 控制台");
            return entry.outputs || {};
        }
        await sleep(POLL_INTERVAL_MS, signal);
    }
}

function firstImage(outputs: Record<string, ComfyOutput>) {
    for (const output of Object.values(outputs)) {
        const image = output?.images?.find((item) => item?.filename);
        if (image) return image;
    }
    return null;
}

async function fetchImage(connection: Connection, image: { filename: string; subfolder: string; type: string }, signal: AbortSignal) {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
    const response = await fetch(targetUrl(connection, `/view?${query.toString()}`), { signal });
    if (!response.ok) throw new Error(`下载生成图失败(HTTP ${response.status})`);
    return blobToDataUrl(await response.blob());
}

async function executeWorkflow(ctx: CanvasNodeContext, config: ComfyConfig, workflow: ApiWorkflow, signal: AbortSignal) {
    const connection = await resolveConnection(ctx);
    const copy = JSON.parse(JSON.stringify(workflow)) as ApiWorkflow;
    applyParams(copy, config.overrides);

    const targets = textTargets(copy);
    // 面板里没填就叫用上游文本节点(例如「反推提示词」产出的文本)
    const positive = config.prompt.trim() || upstreamText(ctx);
    if (targets[0] && positive) copy[targets[0]].inputs = { ...copy[targets[0]].inputs, text: positive };
    if (targets[1] && config.negativePrompt.trim()) copy[targets[1]].inputs = { ...copy[targets[1]].inputs, text: config.negativePrompt };

    const imageNodes = imageTargets(copy);
    const references = referenceImages(ctx, config);
    if (references.length && !imageNodes.length && config.references.length) {
        throw new Error("这份工作流没有 LoadImage 节点,参考图传不进去");
    }
    for (let index = 0; index < Math.min(references.length, imageNodes.length); index++) {
        const name = await uploadReference(connection, references[index], signal);
        copy[imageNodes[index]].inputs = { ...copy[imageNodes[index]].inputs, image: name };
    }

    // 先确认模型/图片都在,避免跑到一半才发现缺文件
    await preflightWorkflow(ctx, copy, references.length > 0, signal);
    const promptId = await queuePrompt(connection, copy, signal);
    const outputs = await waitForOutputs(connection, promptId, signal);
    const image = firstImage(outputs);
    if (!image) throw new Error("这次执行没有产出图片节点");
    return fetchImage(connection, image, signal);
}

export async function resolveWorkflowText(ctx: CanvasNodeContext, config: ComfyConfig) {
    if (!config.workflowId) return config.workflow;
    const entries = await ctx.storage.get<WorkflowEntry[]>(LIBRARY_KEY).catch(() => null);
    const entry = Array.isArray(entries) ? entries.find((item) => item.id === config.workflowId) : undefined;
    return entry?.workflow || config.workflow;
}

export async function loadConfig(ctx: CanvasNodeContext): Promise<ComfyConfig> {
    const cached = configCache.get(ctx.node.id);
    if (cached) return cached;
    const saved = await ctx.storage.get<ComfyConfig>(storageKey(ctx.node.id)).catch(() => null);
    const config = saved && typeof saved === "object" ? { ...DEFAULT_CONFIG, ...saved, references: Array.isArray(saved.references) ? saved.references : [], overrides: saved.overrides || {} } : { ...DEFAULT_CONFIG };
    configCache.set(ctx.node.id, config);
    return config;
}

export async function runNode(ctx: CanvasNodeContext, configOverride?: ComfyConfig) {
    const nodeId = ctx.node.id;
    if (runningRuns.has(nodeId)) return;
    const controller = new AbortController();
    runningRuns.set(nodeId, controller);
    let config = configOverride;
    ctx.updateMetadata({ comfyStatus: "running", comfyError: "", comfyStartedAt: Date.now() });
    try {
        config = config || (await loadConfig(ctx));
        const text = await resolveWorkflowText(ctx, config);
        if (!text.trim()) throw new Error("还没有选工作流:去 配置 → ComfyUI 里导入一份");
        const workflow = parseWorkflow(text);
        const image = await executeWorkflow(ctx, config, workflow, controller.signal);
        ctx.updateMetadata({ content: image, comfyStatus: "success", comfyError: "" });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            ctx.updateMetadata({ comfyStatus: "idle" });
        } else {
            const connection = await resolveConnection(ctx).catch(() => ({ baseUrl: DEFAULT_BASE_URL, proxyUrl: "" }));
            const message = requestError(error, connection);
            ctx.updateMetadata({ comfyStatus: "error", comfyError: message instanceof Error ? message.message : String(message) });
        }
    } finally {
        runningRuns.delete(nodeId);
    }
}

export function stopNode(nodeId: string) {
    runningRuns.get(nodeId)?.abort();
    runningRuns.delete(nodeId);
}

// ---------------------------------------------------------------------------
// 参数元数据:/object_info 决定控件形态(下拉 / 滑杆 / 数字框)
// ---------------------------------------------------------------------------

function inputSpec(info: NodeInfo | undefined, input: string): unknown[] | undefined {
    const spec = info?.input?.required?.[input] ?? info?.input?.optional?.[input];
    return Array.isArray(spec) ? spec : undefined;
}

export type ParamControl = { kind: "enum"; options: string[] } | { kind: "number"; min?: number; max?: number; step?: number } | { kind: "boolean" } | { kind: "text" };

export function describeControl(param: ComfyParam, info: NodeInfo | undefined): ParamControl {
    const spec = inputSpec(info, param.input);
    const type = spec?.[0];
    const options = spec && spec[1] && typeof spec[1] === "object" ? (spec[1] as Record<string, unknown>) : {};
    if (Array.isArray(type)) {
        const values = type.filter((item): item is string => typeof item === "string").slice(0, 400);
        if (values.length) return { kind: "enum", options: values };
    }
    if (type === "INT" || type === "FLOAT") {
        const read = (name: string) => (typeof options[name] === "number" ? (options[name] as number) : undefined);
        const min = read("min");
        const max = read("max");
        const step = read("step") ?? (type === "INT" ? 1 : 0.1);
        const preferExact = /^(width|height|seed|seed2|noise_seed|batch_size)$/i.test(param.input);
        if (!preferExact && min !== undefined && max !== undefined && max > min && max - min <= 20000) return { kind: "number", min, max, step };
        return { kind: "number" };
    }
    if (type === "BOOLEAN") return { kind: "boolean" };
    if (param.control === "number") return { kind: "number" };
    if (param.control === "boolean") return { kind: "boolean" };
    return { kind: "text" };
}

/** 逐个 class_type 拉元数据,命中缓存就跳过;失败静默,UI 退回裸值。 */
export async function loadClassInfos(ctx: CanvasNodeContext, classes: string[], signal: AbortSignal) {
    const connection = await resolveConnection(ctx);
    const found: Record<string, NodeInfo> = {};
    for (const className of classes) {
        const cacheKey = `${connection.baseUrl}|${className}`;
        const cached = objectInfoCache.get(cacheKey);
        if (cached) {
            found[className] = cached;
            continue;
        }
        try {
            const response = await fetch(targetUrl(connection, `/object_info/${encodeURIComponent(className)}`), { signal });
            if (!response.ok) continue;
            const data = (await response.json()) as Record<string, NodeInfo>;
            if (data?.[className]) {
                objectInfoCache.set(cacheKey, data[className]);
                found[className] = data[className];
            }
        } catch {
            // 元数据只是增强
        }
    }
    return found;
}

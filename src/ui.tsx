// ComfyUI 节点的界面:卡片照原生图片节点,下方面板照原生提示词面板
// (40px 胶囊、自绘下拉、两栏提示词、参数浮层)。
import { useCallback, useEffect, useMemo, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodePanelProps } from "@infinite-canvas/plugin-sdk";
import type { CSSProperties, ReactNode } from "react";

import {
    DEFAULT_CONFIG,
    configCache,
    activeNodeIds,
    collectParams,
    describeControl,
    imageSourceOf,
    loadClassInfos,
    loadConfig,
    parseWorkflow,
    runNode,
    runningRuns,
    stopNode,
    storageKey,
    textTargets,
    LIBRARY_KEY,
    type ComfyConfig,
    type ComfyParam,
    type NodeInfo,
    type WorkflowEntry,
} from "./comfy";

type Theme = CanvasNodeContext["theme"];

const STATUS_TEXT: Record<string, string> = { idle: "待运行", running: "生成中…", success: "完成", error: "失败" };

function IconImage({ size = 28 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8.5" cy="8.5" r="1.4" />
            <path d="M21 15.5 16 10.5 5 21.5" />
        </svg>
    );
}

function IconSliders({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
            <circle cx="16" cy="6" r="2" />
            <circle cx="10" cy="12" r="2" />
            <circle cx="18" cy="18" r="2" />
        </svg>
    );
}

function IconChevron({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m6 9 6 6 6-6" />
        </svg>
    );
}

function IconArrowUp({ size = 16 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
        </svg>
    );
}

function IconStop({ size = 12 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// 基础控件:与原生面板一致的 40px 胶囊
// ---------------------------------------------------------------------------

function chipStyle(theme: Theme, active: boolean, hover: boolean) {
    return {
        height: 40,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: "100%",
        borderRadius: 999,
        border: `1px solid ${active ? theme.node.activeStroke : theme.node.stroke}`,
        background: hover || active ? theme.toolbar.activeBg : "transparent",
        color: theme.node.text,
        cursor: "pointer",
        padding: "0 12px",
        fontSize: 12,
        whiteSpace: "nowrap" as const,
    };
}

function Chip({ theme, icon, label, title, onClick, active = false }: { theme: Theme; icon?: ReactNode; label: string; title?: string; onClick: () => void; active?: boolean }) {
    const [hover, setHover] = useState(false);
    return (
        <button type="button" title={title} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={chipStyle(theme, active, hover)}>
            {icon}
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        </button>
    );
}

type Option = { value: string; label: string };

/** 原生 select 的下拉列表跟不了主题(白底),这里自绘一个。fluid 时占满父容器。 */
function Dropdown({ theme, value, options, placeholder, width, fluid = false, compact = false, onChange }: { theme: Theme; value: string; options: Option[]; placeholder: string; width: number; fluid?: boolean; compact?: boolean; onChange: (value: string) => void }) {
    const [open, setOpen] = useState(false);
    const [hover, setHover] = useState(false);
    const [query, setQuery] = useState("");
    const current = options.find((option) => option.value === value);
    const base = chipStyle(theme, open, hover);
    const buttonStyle: CSSProperties = compact
        ? { ...base, height: 30, borderRadius: 8, padding: "0 8px", fontSize: 11.5, width: "100%", justifyContent: "space-between" }
        : { ...base, width: "100%", justifyContent: "space-between" };
    // 选项多时用网格铺开:滚动容器在画布缩放层里会被合成错,尽量不用
    const many = options.length > 12;
    const keyword = query.trim().toLowerCase();
    const shown = many && keyword ? options.filter((option) => option.label.toLowerCase().includes(keyword)) : options;
    return (
        <div style={{ position: "relative", minWidth: 0, width: fluid ? "100%" : undefined, maxWidth: fluid ? "100%" : width }}>
            <button
                type="button"
                onClick={() => {
                    setQuery("");
                    setOpen((prev) => !prev);
                }}
                onMouseEnter={() => setHover(true)}
                onMouseLeave={() => setHover(false)}
                style={buttonStyle}
            >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", color: current ? theme.node.text : theme.node.placeholder }}>{current?.label || placeholder}</span>
                <IconChevron size={compact ? 12 : 14} />
            </button>
            {open ? (
                <>
                    {/* 透明遮罩:点外面关闭,也挡住画布的点击 */}
                    <div style={{ position: "fixed", inset: 0, zIndex: 70 }} onMouseDown={(event) => { event.stopPropagation(); setOpen(false); }} onPointerDown={(event) => event.stopPropagation()} />
                    <div
                        style={{
                            position: "absolute",
                            bottom: "calc(100% + 6px)",
                            left: 0,
                            zIndex: 71,
                            width: many ? 620 : fluid ? "100%" : Math.max(width, 180),
                            maxWidth: "85vw",
                            display: many ? "grid" : "flex",
                            gridTemplateColumns: many ? "repeat(4, minmax(0, 1fr))" : undefined,
                            flexDirection: many ? undefined : "column",
                            gap: 2,
                            padding: 4,
                            borderRadius: 12,
                            border: `1px solid ${theme.toolbar.border}`,
                            background: theme.node.panel,
                            boxShadow: "0 20px 40px -12px rgba(0,0,0,.5)",
                        }}
                    >
                        {many ? (
                            <input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="搜索…"
                                autoFocus
                                onMouseDown={(event) => event.stopPropagation()}
                                style={{ gridColumn: "1 / -1", height: 28, width: "100%", boxSizing: "border-box", borderRadius: 8, border: `1px solid ${theme.node.stroke}`, background: "transparent", color: theme.node.text, fontSize: 11.5, padding: "0 8px", outline: "none" }}
                            />
                        ) : null}
                        {options.length === 0 ? (
                            <div style={{ padding: "8px 10px", fontSize: 11, color: theme.node.placeholder }}>去「配置 → ComfyUI」导入工作流</div>
                        ) : shown.length === 0 ? (
                            <div style={{ padding: "8px 10px", fontSize: 11, color: theme.node.placeholder, gridColumn: "1 / -1" }}>没有匹配项</div>
                        ) : (
                            shown.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                        onChange(option.value);
                                        setOpen(false);
                                    }}
                                    style={{
                                        textAlign: "left",
                                        padding: "7px 10px",
                                        borderRadius: 8,
                                        border: "none",
                                        background: option.value === value ? theme.toolbar.activeBg : "transparent",
                                        color: theme.node.text,
                                        fontSize: 12,
                                        cursor: "pointer",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                    }}
                                >
                                    {option.label}
                                </button>
                            ))
                        )}
                    </div>
                </>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 节点卡片
// ---------------------------------------------------------------------------

export function NodeContent({ ctx }: CanvasNodeContentProps) {
    const content = ctx.node.metadata?.content || "";
    const status = String(ctx.node.metadata?.comfyStatus || "idle");
    const error = String(ctx.node.metadata?.comfyError || "");
    const startedAt = Number(ctx.node.metadata?.comfyStartedAt || 0);
    const [elapsed, setElapsed] = useState(0);

    // 运行中每秒刷新耗时,让长任务看得出还在动
    useEffect(() => {
        if (status !== "running") {
            setElapsed(0);
            return;
        }
        const from = startedAt || Date.now();
        const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - from) / 1000)));
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [status, startedAt]);

    const statusLabel = status === "running" ? `生成中… ${elapsed}s` : STATUS_TEXT[status] || status;

    if (!content) {
        return (
            <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: ctx.theme.node.placeholder }}>
                <IconImage />
                <span style={{ fontSize: 12 }}>{status === "running" ? statusLabel : error ? "运行失败" : "空图片节点"}</span>
                {error ? (
                    <span title={error} style={{ fontSize: 10, maxWidth: "85%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {error}
                    </span>
                ) : null}
            </div>
        );
    }

    return (
        <div style={{ position: "relative", height: "100%", width: "100%" }}>
            <img src={content} alt="ComfyUI 输出" draggable={false} style={{ height: "100%", width: "100%", objectFit: "contain", borderRadius: 16, display: "block" }} />
            <span style={{ position: "absolute", left: 8, bottom: 8, padding: "1px 6px", borderRadius: 6, fontSize: 11, background: "rgba(0,0,0,.55)", color: "#fff" }}>{statusLabel}</span>
            {error ? <span title={error} style={{ position: "absolute", left: 8, right: 8, bottom: 30, padding: "3px 6px", borderRadius: 6, fontSize: 11, background: "rgba(190,18,60,.85)", color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{error}</span> : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 下方面板
// ---------------------------------------------------------------------------

/** ComfyUI 原生输入名的中文注释;认不出来的保留原名。 */
const PARAM_LABELS: Record<string, string> = {
    ckpt_name: "模型",
    lora_name: "LoRA 模型",
    vae_name: "VAE 模型",
    unet_name: "UNET 模型",
    clip_name: "CLIP 模型",
    clip_name1: "CLIP 模型 1",
    clip_name2: "CLIP 模型 2",
    clip_name3: "CLIP 模型 3",
    control_net_name: "ControlNet 模型",
    model_name: "模型文件",
    style_model_name: "风格模型",
    gligen_name: "GLIGEN 模型",
    image: "图片",
    text: "提示词",
    width: "宽度",
    height: "高度",
    batch_size: "批量张数",
    seed: "随机种子",
    noise_seed: "噪声种子",
    steps: "步数",
    cfg: "提示词强度",
    sampler_name: "采样器",
    scheduler: "调度器",
    denoise: "重绘幅度",
    filename_prefix: "文件名前缀",
    strength: "强度",
    start_percent: "起始百分比",
    end_percent: "结束百分比",
    resolution: "分辨率",
    upscale_method: "放大算法",
    crop: "裁剪方式",
    add_noise: "添加噪声",
    return_with_leftover_noise: "保留剩余噪声",
    start_at_step: "起始步数",
    end_at_step: "结束步数",
    noise_mode: "噪声模式",
    batch_seed_mode: "批量种子模式",
    variation_seed: "变化种子",
    variation_strength: "变化强度",
    variation_method: "变化方式",
    internal_seed: "内部种子",
    weight_interpretation: "权重解释方式",
    token_normalization: "词元归一化",
    stop_at_clip_layer: "CLIP 层截断",
    type: "类型",
    noise_type: "噪声类型",
    scale: "缩放",
    amount: "数量",
};

function prettyName(input: string) {
    return PARAM_LABELS[input] || input.replace(/_/g, " ");
}

export function Panel({ ctx }: CanvasNodePanelProps) {
    const theme = ctx.theme;
    const nodeId = ctx.node.id;
    const [config, setConfig] = useState<ComfyConfig>(() => configCache.get(nodeId) || DEFAULT_CONFIG);
    const [library, setLibrary] = useState<WorkflowEntry[]>([]);
    const [infos, setInfos] = useState<Record<string, NodeInfo>>({});
    // 画布缩放会重建组件,参数卡的展开状态放进 metadata 才不会自己关掉
    const settingsOpen = Boolean(ctx.node.metadata?.comfySettingsOpen);
    const setSettingsOpen = (value: boolean | ((prev: boolean) => boolean)) => {
        const current = Boolean(ctx.node.metadata?.comfySettingsOpen);
        const next = typeof value === "function" ? value(current) : value;
        if (next !== current) ctx.updateMetadata({ comfySettingsOpen: next });
    };
    const [pickerOpen, setPickerOpen] = useState(false);
    const [reversing, setReversing] = useState(false);
    const [reverseHint, setReverseHint] = useState("");
    const cardRef = useRef<HTMLDivElement>(null);
    const chipRef = useRef<HTMLSpanElement>(null);
    const [busy, setBusy] = useState(runningRuns.has(nodeId));
    const saveTimer = useRef<number | null>(null);

    useEffect(() => {
        let alive = true;
        void loadConfig(ctx).then((loaded) => {
            if (alive) setConfig(loaded);
        });
        void ctx.storage.get<WorkflowEntry[]>(LIBRARY_KEY).then((saved) => {
            if (alive && Array.isArray(saved)) setLibrary(saved);
        });
        return () => {
            alive = false;
        };
        // ctx 每次渲染都是新对象,依赖只放节点 id
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodeId]);

    const update = useCallback(
        (patch: Partial<ComfyConfig>) => {
            setConfig((prev) => {
                const next = { ...prev, ...patch };
                configCache.set(nodeId, next);
                if (saveTimer.current) window.clearTimeout(saveTimer.current);
                saveTimer.current = window.setTimeout(() => void ctx.storage.set(storageKey(nodeId), next), 300);
                return next;
            });
        },
        [ctx, nodeId],
    );

    const entry = library.find((item) => item.id === config.workflowId);
    // 「配置 → ComfyUI」里勾过的参数才上参数卡;没勾就全显示
    const selectedParamKeys = entry?.visibleParams?.length ? new Set(entry.visibleParams) : null;
    const workflowText = entry?.workflow || config.workflow;
    const workflow = useMemo(() => {
        try {
            return parseWorkflow(workflowText);
        } catch {
            return null;
        }
    }, [workflowText]);
    const params = useMemo(() => (workflow ? collectParams(workflow) : []), [workflow]);
    // 没接进输出的节点不会被执行,参数卡与提示词映射都不该带上它们
    const activeIds = useMemo(() => (workflow ? activeNodeIds(workflow) : new Set<string>()), [workflow]);
    // 正/负提示词由面板两栏负责,参数卡里不再重复列
    const hiddenParamKeys = useMemo(() => {
        if (!workflow) return new Set<string>();
        return new Set(textTargets(workflow).slice(0, 2).map((nodeId) => `${nodeId}.text`));
    }, [workflow]);
    const visibleParams = params.filter(
        (param) => activeIds.has(param.nodeId) && (!selectedParamKeys || selectedParamKeys.has(`${param.nodeId}.${param.input}`)) && !hiddenParamKeys.has(`${param.nodeId}.${param.input}`),
    );
    // 参考图按顺序填给 LoadImage,数量对不上时要讲清楚
    const imageNodeCount = useMemo(() => (workflow ? Object.values(workflow).filter((node) => /loadimage/i.test(node.class_type || "")).length : 0), [workflow]);

    const classes = useMemo(() => {
        const names = new Set<string>();
        if (workflow) for (const node of Object.values(workflow)) if (node?.class_type) names.add(node.class_type);
        return Array.from(names).slice(0, 40);
    }, [workflow]);

    useEffect(() => {
        if (!classes.length) return;
        let alive = true;
        const controller = new AbortController();
        void loadClassInfos(ctx, classes, controller.signal).then((found) => {
            if (alive && Object.keys(found).length) setInfos((prev) => ({ ...prev, ...found }));
        });
        return () => {
            alive = false;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [classes]);

    const options = library.map((item) => ({ value: item.id, label: item.name }));

    const pickWorkflow = (id: string) => {
        const picked = library.find((item) => item.id === id);
        update({ workflowId: picked?.id || "", workflowName: picked?.name || "", workflow: picked?.workflow || "", overrides: {} });
    };

    const run = () => {
        if (runningRuns.has(nodeId)) {
            stopNode(nodeId);
            setBusy(false);
            return;
        }
        void ctx.storage.set(storageKey(nodeId), config);
        setBusy(true);
        void runNode(ctx, config).finally(() => setBusy(false));
    };

    const widthParam = params.find((param) => param.input === "width");
    const heightParam = params.find((param) => param.input === "height");
    const stepsParam = params.find((param) => param.input === "steps");
    const sizeHint = widthParam && heightParam ? `${widthParam.value}×${heightParam.value}${stepsParam ? ` · ${stepsParam.value} 步` : ""}` : "参数";

    // 点外面关掉参数卡;点 ⚙ 自己不算外面的点击
    useEffect(() => {
        if (!settingsOpen) return;
        const handler = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (cardRef.current?.contains(target) || chipRef.current?.contains(target)) return;
            setSettingsOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [settingsOpen]);

    const canRun = Boolean(config.prompt.trim() || config.workflowId || config.workflow.trim());
    // 参考图:上游连线的图排最前并自动带上,其次才是手动挑的
    const upstreamUrls = ctx.getUpstream().map(imageSourceOf).filter(Boolean);
    const manualRefs = config.references
        .map((id) => {
            const node = ctx.getNode(id);
            return { id, src: node ? imageSourceOf(node) : "", title: node?.title || "图片" };
        })
        .filter((item) => Boolean(item.src));
    const upstreamChips = config.ignoreUpstream
        ? []
        : upstreamUrls.filter((url) => !manualRefs.some((item) => item.src === url)).map((src, index) => ({ id: `upstream-${index}`, src, title: "上游连线图片", upstream: true }));
    const referenceChips = [...upstreamChips, ...manualRefs.map((item) => ({ ...item, upstream: false }))];
    const canvasImages = pickerOpen ? ctx.getNodes().filter((node) => node.id !== nodeId && Boolean(imageSourceOf(node))).slice(0, 40) : [];
    const toggleReference = (id: string) => {
        const next = config.references.includes(id) ? config.references.filter((item) => item !== id) : [...config.references, id];
        update({ references: next });
    };

    // 用第一张参考图(连线图优先)让视觉模型反推提示词
    const reversePrompt = async () => {
        const source = referenceChips[0]?.src;
        if (!source) {
            setReverseHint("先选一张参考图，或连一个图片节点");
            return;
        }
        setReversing(true);
        setReverseHint("");
        try {
            const answer = await ctx.ai.generateText(
                "请根据参考图片反推一段适合用于 AI 生图的提示词。只输出提示词正文，不要解释；覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围；用英文逗号分隔的短语。",
                { images: [source] },
            );
            const text = answer.text.trim();
            if (!text) throw new Error("模型没有返回内容");
            update({ prompt: text });
        } catch (error) {
            setReverseHint(error instanceof Error ? error.message : "反推失败");
        } finally {
            setReversing(false);
        }
    };
    const field: CSSProperties = { width: "100%", boxSizing: "border-box", height: 30, borderRadius: 8, border: `1px solid ${theme.node.stroke}`, background: "transparent", color: theme.node.text, fontSize: 11.5, padding: "0 8px", outline: "none" };

    return (
        <div
            data-canvas-no-zoom
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            style={{ position: "relative", isolation: "isolate", background: theme.toolbar.panel, border: `1px solid ${theme.toolbar.border}`, borderRadius: 16, padding: 12, color: theme.node.text, boxShadow: "0 25px 50px -12px rgba(0,0,0,.45)" }}
        >
            <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, marginBottom: 10, minHeight: 44 }}>
                <span style={{ flex: "0 0 auto", fontSize: 11, color: theme.node.placeholder }}>参考内容</span>
                <div className="comfyui-ref-strip" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflowX: "auto", flex: "0 1 auto" }}>
                    {referenceChips.map((item, index) => (
                        <div key={item.id} style={{ position: "relative", flex: "0 0 auto" }}>
                            <img
                                src={item.src}
                                alt={item.title}
                                title={`${index + 1}. ${item.title}`}
                                style={{ height: 40, width: 40, objectFit: "cover", borderRadius: 10, border: `1px solid ${item.upstream ? theme.node.activeStroke : theme.node.stroke}`, display: "block" }}
                            />
                            <button
                                type="button"
                                aria-label={item.upstream ? "不使用上游图片" : "移除参考图"}
                                title={item.upstream ? "不使用上游图片" : "移除"}
                                onClick={() => (item.upstream ? update({ ignoreUpstream: true }) : toggleReference(item.id))}
                                style={{ position: "absolute", top: 2, right: 2, height: 16, width: 16, borderRadius: 999, border: "none", background: "rgba(0,0,0,.58)", color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer", padding: 0, display: "grid", placeItems: "center" }}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    <button
                        type="button"
                        title="从画布挑选参考图"
                        onClick={() => {
                            setPickerOpen((prev) => !prev);
                            setSettingsOpen(false);
                        }}
                        style={{ height: 40, width: 40, flex: "0 0 auto", borderRadius: 10, border: `1px dashed ${theme.node.stroke}`, background: "transparent", color: theme.node.text, cursor: "pointer", fontSize: 18, lineHeight: 1 }}
                    >
                        +
                    </button>
                    {config.ignoreUpstream && upstreamUrls.length ? (
                        <button
                            type="button"
                            title="重新使用上游连线的图片"
                            onClick={() => update({ ignoreUpstream: false })}
                            style={{ height: 40, flex: "0 0 auto", padding: "0 10px", borderRadius: 10, border: `1px dashed ${theme.node.stroke}`, background: "transparent", color: theme.node.placeholder, cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}
                        >
                            使用上游
                        </button>
                    ) : null}
                </div>
                {referenceChips.length > 0 ? (
                    <span style={{ flex: "0 0 auto", fontSize: 10.5, color: referenceChips.length > imageNodeCount ? "#e11d48" : theme.node.placeholder }}>
                        {imageNodeCount === 0 ? "工作流没有 LoadImage 节点" : referenceChips.length > imageNodeCount ? `工作流只有 ${imageNodeCount} 个 LoadImage，多出的不会用` : `${referenceChips.length}/${imageNodeCount} 张`}
                    </span>
                ) : (
                    <span style={{ flex: "0 1 auto", minWidth: 0, fontSize: 10.5, color: theme.node.placeholder, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>连线图片会自动排在第一张</span>
                )}
                <button
                    type="button"
                    onClick={() => void reversePrompt()}
                    disabled={reversing}
                    title="用参考图让文本模型反推提示词"
                    style={{ marginLeft: "auto", flex: "0 0 auto", height: 28, padding: "0 10px", borderRadius: 999, border: `1px solid ${theme.node.stroke}`, background: reversing ? theme.toolbar.activeBg : "transparent", color: theme.node.text, cursor: reversing ? "wait" : "pointer", fontSize: 11.5, whiteSpace: "nowrap" }}
                >
                    {reversing ? "反推中…" : "反推"}
                </button>
                {reverseHint ? (
                    <span title={reverseHint} style={{ flex: "0 1 auto", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10.5, color: "#e11d48" }}>
                        {reverseHint}
                    </span>
                ) : null}
                {pickerOpen ? (
                    <>
                        <div style={{ position: "fixed", inset: 0, zIndex: 80 }} onMouseDown={(event) => { event.stopPropagation(); setPickerOpen(false); }} onPointerDown={(event) => event.stopPropagation()} />
                        <div
                            style={{
                                position: "absolute",
                                top: 44,
                                left: 0,
                                zIndex: 81,
                                width: 300,
                                maxHeight: 280,
                                overflowY: "auto",
                                overflowX: "hidden",
                                display: "flex",
                                flexDirection: "column",
                                gap: 2,
                                padding: 6,
                                borderRadius: 14,
                                border: `1px solid ${theme.toolbar.border}`,
                                background: theme.node.panel,
                                boxShadow: "0 24px 48px -12px rgba(0,0,0,.55)",
                            }}
                        >
                            {canvasImages.length === 0 ? <div style={{ padding: "8px 10px", fontSize: 11, color: theme.node.placeholder }}>画布上还没有图片节点</div> : null}
                            {canvasImages.map((node) => {
                                const selected = config.references.includes(node.id);
                                return (
                                    <button
                                        key={node.id}
                                        type="button"
                                        onClick={() => toggleReference(node.id)}
                                        style={{ display: "flex", alignItems: "center", gap: 8, padding: 4, borderRadius: 8, border: "none", background: selected ? theme.toolbar.activeBg : "transparent", color: theme.node.text, cursor: "pointer", textAlign: "left" }}
                                    >
                                        <img src={node.metadata?.content || ""} alt="" style={{ height: 32, width: 32, objectFit: "cover", borderRadius: 6, flex: "0 0 auto" }} />
                                        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{node.title || "图片"}</span>
                                        <span style={{ flex: "0 0 auto", fontSize: 11, color: theme.node.placeholder }}>{selected ? "已选" : ""}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </>
                ) : null}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr", gap: 8 }}>
                <textarea
                    value={config.prompt}
                    onChange={(event) => update({ prompt: event.target.value })}
                    placeholder="描述要生成的图片内容（留空则用上游文本节点）"
                    onMouseDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                    style={{ height: 132, width: "100%", boxSizing: "border-box", resize: "none", border: "none", outline: "none", background: "transparent", color: theme.node.text, fontSize: 14, lineHeight: 1.55, padding: "4px 6px" }}
                />
                <div style={{ background: theme.toolbar.border, margin: "6px 0" }} />
                <textarea
                    value={config.negativePrompt}
                    onChange={(event) => update({ negativePrompt: event.target.value })}
                    placeholder="反向提示词(可选)"
                    onMouseDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                    style={{ height: 132, width: "100%", boxSizing: "border-box", resize: "none", border: "none", outline: "none", background: "transparent", color: theme.node.muted, fontSize: 13, lineHeight: 1.55, padding: "4px 6px" }}
                />
            </div>

            <div style={{ position: "relative", marginTop: 8, display: "flex", minWidth: 0, alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 8 }}>
                    <span ref={chipRef} style={{ display: "inline-flex", minWidth: 0 }}>
                        <Chip theme={theme} active={settingsOpen} icon={<IconSliders />} label={sizeHint} title="该工作流的参数" onClick={() => { setSettingsOpen((prev) => !prev); setPickerOpen(false); }} />
                    </span>
                    <Dropdown theme={theme} value={config.workflowId} options={options} placeholder={library.length ? "选择工作流" : "还没有工作流"} width={190} onChange={pickWorkflow} />
                </div>
                <button
                    type="button"
                    onClick={run}
                    disabled={!busy && !canRun}
                    aria-label={busy ? "停止生成" : "生成"}
                    style={{
                        height: 40,
                        width: 64,
                        flex: "0 0 auto",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 999,
                        border: "none",
                        background: busy ? theme.node.activeStroke : canRun ? theme.node.text : theme.node.fill,
                        color: busy || canRun ? theme.toolbar.panel : theme.node.placeholder,
                        cursor: busy || canRun ? "pointer" : "not-allowed",
                    }}
                >
                    {busy ? <IconStop /> : <IconArrowUp />}
                </button>
            </div>

            {settingsOpen ? (
                <div
                    ref={cardRef}
                    onMouseDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                    style={{
                        position: "absolute",
                        top: "calc(100% + 10px)",
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 61,
                        width: 700,
                        maxWidth: "92vw",
                        background: theme.node.panel,
                        border: `1px solid ${theme.toolbar.border}`,
                        borderRadius: 16,
                        padding: "12px 14px",
                        boxShadow: "0 24px 48px -12px rgba(0,0,0,.55)",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, flex: "0 0 auto" }}>工作流参数</span>
                            {config.workflowName ? <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: theme.node.placeholder }}>{config.workflowName}</span> : null}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
                            <button
                                type="button"
                                onClick={() => setSettingsOpen(false)}
                                aria-label="关闭参数"
                                style={{ border: "none", background: "transparent", color: theme.node.placeholder, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 2 }}
                            >
                                ×
                            </button>
                        </div>
                    </div>
                    {visibleParams.length === 0 ? (
                        <div style={{ fontSize: 11, color: theme.node.placeholder }}>{selectedParamKeys ? "还没勾选要显示的参数，去「配置 → ComfyUI → 卡片上显示的参数」里勾。" : "选一个有内容的工作流后，这里会列出它的参数。"}</div>
                    ) : null}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 18px" }}>{visibleParams.map((param) => renderParam(param, config, infos, theme, field, update))}</div>
                </div>
            ) : null}
        </div>
    );
}

function renderParam(param: ComfyParam, config: ComfyConfig, infos: Record<string, NodeInfo>, theme: Theme, field: CSSProperties, update: (patch: Partial<ComfyConfig>) => void) {
    const key = `${param.nodeId}.${param.input}`;
    const value = key in config.overrides ? config.overrides[key] : param.value;
    const control = describeControl(param, infos[param.classType]);
    const textInput = (
        <input
            value={String(value)}
            inputMode={control.kind === "number" ? "decimal" : "text"}
            onChange={(event) => update({ overrides: { ...config.overrides, [key]: control.kind === "number" ? Number(event.target.value) || 0 : event.target.value } })}
            onMouseDown={(event) => event.stopPropagation()}
            style={{ ...field, flex: "1 1 auto", minWidth: 0 }}
        />
    );

    return (
        <label key={key} title={key} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 34, fontSize: 11.5, color: theme.node.placeholder, minWidth: 0 }}>
            <span style={{ flex: "0 0 38%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prettyName(param.input)}</span>
            {control.kind === "enum" && control.options.length <= 4 ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: 4, flex: "1 1 auto", minWidth: 0, alignItems: "center" }}>
                    {control.options.map((option) => {
                        const active = String(value) === option;
                        return (
                            <button
                                key={option}
                                type="button"
                                onClick={() => update({ overrides: { ...config.overrides, [key]: option } })}
                                style={{ height: 30, padding: "0 10px", borderRadius: 8, border: `1px solid ${active ? theme.node.activeStroke : theme.node.stroke}`, background: active ? theme.toolbar.activeBg : "transparent", color: theme.node.text, fontSize: 11.5, cursor: "pointer" }}
                            >
                                {option}
                            </button>
                        );
                    })}
                </span>
            ) : control.kind === "enum" ? (
                <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                    <Dropdown theme={theme} value={String(value)} options={control.options.map((option) => ({ value: option, label: option }))} placeholder="选择" width={240} fluid compact onChange={(next) => update({ overrides: { ...config.overrides, [key]: next } })} />
                </span>
            ) : control.kind === "number" && control.min !== undefined && control.max !== undefined ? (
                <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 auto", minWidth: 0, height: 30 }}>
                    <input type="range" min={control.min} max={control.max} step={control.step || 1} value={Number(value)} onChange={(event) => update({ overrides: { ...config.overrides, [key]: Number(event.target.value) } })} onMouseDown={(event) => event.stopPropagation()} style={{ flex: 1, minWidth: 0, accentColor: theme.node.text }} />
                    <span style={{ flex: "0 0 auto", minWidth: 34, textAlign: "right", fontVariantNumeric: "tabular-nums", color: theme.node.muted }}>{String(value)}</span>
                </span>
            ) : control.kind === "boolean" ? (
                <input type="checkbox" checked={Boolean(value)} onChange={(event) => update({ overrides: { ...config.overrides, [key]: event.target.checked } })} style={{ flex: "0 0 auto", accentColor: theme.node.text }} />
            ) : (
                textInput
            )}
        </label>
    );
}

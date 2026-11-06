// ComfyUI 节点:专属节点,外观与交互照原生图片节点。
// 逻辑在 comfy.ts,界面在 ui.tsx,这里只做插件声明。
import { definePlugin } from "@infinite-canvas/plugin-sdk";

import { runningRuns, runNode, stopNode } from "./comfy";
import { NodeContent, Panel } from "./ui";

export default definePlugin({
    id: "comfyui",
    name: "ComfyUI 节点",
    version: "1.8.1",
    description: "在本机 ComfyUI 上执行 API 格式工作流,结果写回画布",
    // 参考图横条不要系统滚动条:和整体 UI 保持一致
    css: ".comfyui-ref-strip{scrollbar-width:none;-ms-overflow-style:none}.comfyui-ref-strip::-webkit-scrollbar{width:0;height:0}",
    nodes: [
        {
            type: "comfyui:workflow",
            title: "ComfyUI",
            icon: "🧩",
            description: "跑本机 ComfyUI 工作流",
            defaultSize: { width: 360, height: 360 },
            defaultMetadata: { content: "", comfyStatus: "idle" },
            minimapColor: "#22c55e",
            autoOpenPanel: true,
            resource: (node) => {
                const url = node.metadata?.content;
                return url ? { kind: "image", url } : null;
            },
            onDoubleClick: (ctx) => {
                ctx.openPanel();
                return true;
            },
            toolbar: (ctx) => {
                const running = runningRuns.has(ctx.node.id);
                return [
                    {
                        id: "comfyui-run",
                        title: running ? "停止当前工作流" : "运行工作流(参考上游图片)",
                        label: running ? "停止" : "运行",
                        icon: running ? "■" : "▶",
                        onClick: () => (running ? stopNode(ctx.node.id) : void runNode(ctx)),
                    },
                ];
            },
            Content: NodeContent,
            Panel,
        },
    ],
});

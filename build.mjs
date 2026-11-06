// 构建 comfyui.js：产物是单个 ESM 文件，插件市场直接按 URL 加载。
// 插件依赖 AIGC 画布的插件 SDK（宿主仓库未公开），本地构建时用 CANVAS_SDK 指向它，
// 例如 CANVAS_SDK=D:/work/infinite-canvas/plugins/canvas/sdk/src npm run build
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(process.env.CANVAS_SDK || join(root, "..", "infinite-canvas", "plugins", "canvas", "sdk", "src"));

if (!fs.existsSync(join(sdk, "index.ts"))) {
    console.error(`找不到插件 SDK：${sdk}`);
    console.error("请用 CANVAS_SDK 指向 infinite-canvas/plugins/canvas/sdk/src 后再构建。");
    process.exit(1);
}

// SDK 的 package.json exports 有三条入口，这里按同样的映射解析
const alias = {
    name: "sdk-alias",
    setup(builder) {
        builder.onResolve({ filter: /^@infinite-canvas\/plugin-sdk(\/.*)?$/ }, (args) => {
            if (args.path === "@infinite-canvas/plugin-sdk") return { path: join(sdk, "index.ts") };
            if (args.path === "@infinite-canvas/plugin-sdk/jsx-runtime") return { path: join(sdk, "jsx-runtime.ts") };
            if (args.path === "@infinite-canvas/plugin-sdk/jsx-dev-runtime") return { path: join(sdk, "jsx-dev-runtime.ts") };
            return null;
        });
    },
};

await build({
    entryPoints: [join(root, "src", "index.tsx")],
    outfile: join(root, "comfyui.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "@infinite-canvas/plugin-sdk",
    loader: { ".js": "jsx", ".jsx": "jsx", ".ts": "ts", ".tsx": "tsx", ".css": "text" },
    external: ["react", "react-dom"],
    minify: true,
    plugins: [alias],
    logLevel: "warning",
});

console.log("built comfyui.js");

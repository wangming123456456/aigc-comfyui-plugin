# AIGC 画布 · ComfyUI 节点插件

给 [AIGC 画布](https://github.com/wangming123456456/aigc-studio)（Infinite Canvas）用的专属节点：在画布上选一个 ComfyUI 工作流，填提示词、挂参考图，点发送就把结果写回画布，外观和行为跟原生图片节点一致。

## 安装

插件市场里选「从 URL 安装」，粘贴：

```
https://cdn.jsdelivr.net/gh/wangming123456456/aigc-comfyui-plugin@main/comfyui.js
```

安装后节点菜单里会多出「ComfyUI 节点」。

## 用之前先配好

打开「配置 → ComfyUI」：

1. **服务地址**：ComfyUI 默认是 `http://127.0.0.1:8188`。
2. **代理地址**（推荐）：ComfyUI 会给带 `Origin` 头的请求直接回 403，浏览器直连必然被挡。起一个本地代理即可，默认 `http://127.0.0.1:23210`：

   ```
   npx @basketikun/canvas-proxy
   ```

   留空时插件会自动探测 `127.0.0.1:23210`。
3. **工作流库**：导入 ComfyUI 导出的 **API 格式** 工作流（`工作流 → 导出 → 导出 API`，不是普通 `.json`），命名保存。
4. 需要的话，在「卡片上显示的参数」里挑几个要调的参数，还能直接改默认值。

## 节点怎么用

- 面板下拉选工作流，左栏写正向提示词（留空则用上游文本节点），右栏填反向提示词。
- 参考图：连线上的图片会自动排第一；也可以点 `+` 从画布挑，按顺序填给工作流的 LoadImage。
- 「反推」按钮：用参考图让宿主配置的文本模型写提示词（需要多模态模型）。
- 齿轮：调当前工作流的参数，只显示真正会执行、并且你在设置里勾过的参数。
- 运行前会预检模型文件是否存在，缺文件直接报名字，不会跑到一半失败。

## 自己构建

本插件依赖 AIGC 画布的插件 SDK（宿主仓库未公开），构建时用 `CANVAS_SDK` 指向它：

```bash
npm install
CANVAS_SDK=/path/to/infinite-canvas/plugins/canvas/sdk/src npm run build
```

产物是同目录的 `comfyui.js`，单个 ESM 文件，直接提交即可被 jsDelivr 分发。

## 许可

MIT

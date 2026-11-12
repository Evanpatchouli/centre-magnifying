# Centre Magnifying

Electron + React + TypeScript 实现的“指定窗口中心区域实时圆形放大器”。

## 环境变量

`CENTRE_MAGNIFYING_FILTER_WGC_LOGS` 用于控制在执行 `npm run dev` 时，是否过滤重复出现的 Windows Graphics Capture 帧复用日志。

- 未设置，或设置为类似 `false` 的值时，默认不启用过滤。
- 设置为 `1`、`true`、`yes` 或 `on` 时，启用过滤。
- 本项目中的 `.env`、`.env.development` 和 `.env.production` 默认启用过滤。

`CENTRE_MAGNIFYING_ENABLE_WEBGL` 用于控制是否允许选择 WebGL 渲染模式。

`CENTRE_MAGNIFYING_ENABLE_NATIVE_WGC` 用于控制是否允许选择 Native WGC 渲染模式。

`CENTRE_MAGNIFYING_WEBGL_PROBE_LOGS` 用于启用带有 `[webgl-probe]` 前缀的 WebGL 诊断日志。  
在测试 WebGL 纹理上传和 framebuffer 输出时可以开启。

仅在诊断 WebGL 问题时设置：

```bash
CENTRE_MAGNIFYING_WEBGL_PROBE_LOGS=true
````

该功能默认关闭。

`CENTRE_MAGNIFYING_NATIVE_WGC_PROBE_LOGS` 用于启用带有 `[native-wgc-probe]` 前缀的 Native WGC 诊断日志。
在测试原生捕获初始化、帧到达、裁剪坐标和 swapchain 呈现时可以开启。

## 功能

* 透明、置顶、鼠标穿透的圆形放大镜窗口
* 系统托盘菜单：设置 / 退出
* 设置窗口可选择当前系统中的目标应用窗口
* 可配置捕获半径、缩放比例、帧率、图像平滑
* 捕获目标窗口视频流，并在渲染端使用 canvas 裁剪目标窗口中心区域

## 为什么捕获目标窗口，而不是屏幕中心？

如果放大镜窗口位于屏幕中心，同时又捕获屏幕中心区域，就可能捕获到自己的上一帧画面，从而形成反馈回路，表现为画面静止或递归。

本项目的核心策略是：

```txt
目标应用窗口视频流 → 裁剪目标窗口中心区域 → 放大到透明置顶窗口
```

## 开发运行

```bash
pnpm install
pnpm dev
```

## 编译原生捕获模块

Windows 上使用 Native WGC 模式前，需安装 Visual Studio C++ 桌面开发工具和 Python，然后执行：

```bash
npm run build:addon
```

该命令使用项目安装的 Electron 版本及其头文件编译模块；首次运行需要联网下载头文件。

## 打包

```bash
pnpm build
pnpm dist
```

## 目录结构

```txt
src/
├─ main/
│  ├─ index.ts       # 应用入口
│  ├─ tray.ts        # 系统托盘菜单
│  ├─ windows.ts     # 放大镜窗口和设置窗口
│  ├─ ipc.ts         # IPC 接口
│  ├─ store.ts       # 配置持久化
│  └─ types.ts
├─ preload/
│  └─ index.ts       # 通过 contextBridge 暴露安全 API
└─ renderer/
   ├─ magnifier/     # 放大镜渲染页
   ├─ settings/      # 设置页
   └─ shared/
```

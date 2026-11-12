import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import appIcon from "../../../resources/icon.svg";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { CaptureSourceDTO, MagnifierSettings, RenderModeFeatures } from "../shared/types";

const FPS_OPTIONS: MagnifierSettings["fps"][] = [30, 60, 90, 120];
const DEFAULT_RENDER_MODE_FEATURES: RenderModeFeatures = {
  canvas2d: true,
  webgl: false,
  nativeWgc: false,
  webglProbeLogs: false,
  nativeWgcProbeLogs: false,
};

type IconName =
  | "target"
  | "sliders"
  | "layers"
  | "keyboard"
  | "refresh"
  | "info"
  | "check"
  | "alert"
  | "close"
  | "chevron"
  | "window"
  | "lens";

const ICON_PATHS: Record<IconName, ReactNode> = {
  target: (
    <>
      <circle cx="12" cy="12" r="6.6" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <path d="M12 2.4v3.1M12 18.5v3.1M2.4 12h3.1M18.5 12h3.1" />
    </>
  ),
  sliders: (
    <>
      <path d="M3.5 7.5h8M16.5 7.5h4M3.5 16.5h4M12.5 16.5h8" />
      <circle cx="14" cy="7.5" r="2.3" />
      <circle cx="10" cy="16.5" r="2.3" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3.2 21 8l-9 4.8L3 8l9-4.8Z" />
      <path d="m3 12.3 9 4.8 9-4.8" />
      <path d="m3 16.6 9 4.8 9-4.8" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.6" />
      <path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M6 13.5h.01M9 13.5h.01M12 13.5h.01M15 13.5h.01M18 13.5h.01M7.5 16.5h9" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 3.8v4.4h-4.4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 10.8v5.2" />
      <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="m4.8 12.6 4.7 4.7L19.4 7" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.4v5.4" />
      <circle cx="12" cy="16.2" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  close: <path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6" />,
  chevron: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  window: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.6" />
      <path d="M3 9h18" />
      <circle cx="6" cy="6.8" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  lens: (
    <>
      <circle cx="10.6" cy="10.6" r="6.6" />
      <path d="m15.6 15.6 5 5" />
    </>
  ),
};

function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

type TabId = "target" | "optics" | "render" | "hotkey";

type TabDef = {
  id: TabId;
  label: string;
  icon: IconName;
  index: string;
};

const TABS: TabDef[] = [
  { id: "target", label: "目标窗口", icon: "target", index: "01" },
  { id: "optics", label: "放大参数", icon: "sliders", index: "02" },
  { id: "render", label: "渲染管线", icon: "layers", index: "03" },
  { id: "hotkey", label: "快捷键", icon: "keyboard", index: "04" },
];

type ModeItem = {
  id: MagnifierSettings["renderMode"];
  label: string;
  tag: string;
  desc: string;
  icon: IconName;
  featureKey: keyof RenderModeFeatures;
  summary: { capture: string; crop: string; output: string };
};

const MODE_ITEMS: ModeItem[] = [
  {
    id: "canvas2d",
    label: "Canvas 2D",
    tag: "兼容",
    desc: "Chromium 媒体流捕获，在 Canvas 上完成圆形裁剪。",
    icon: "window",
    featureKey: "canvas2d",
    summary: { capture: "Chromium MediaStream", crop: "Canvas 圆形裁剪", output: "2D Canvas" },
  },
  {
    id: "webgl",
    label: "WebGL",
    tag: "实验",
    desc: "中间 Canvas 上传纹理，由着色器完成缩放与圆形遮罩。",
    icon: "layers",
    featureKey: "webgl",
    summary: { capture: "Chromium MediaStream", crop: "中心裁剪 + 圆形遮罩", output: "WebGL 纹理" },
  },
  {
    id: "native-wgc",
    label: "Native WGC",
    tag: "实验",
    desc: "Windows 原生窗口捕获，D3D11 渲染，不经过 Chromium 层。",
    icon: "lens",
    featureKey: "nativeWgc",
    summary: { capture: "Windows.Graphics.Capture", crop: "窗口圆形遮罩", output: "D3D11 + HLSL" },
  },
];

const DIRTY_KEYS: Record<TabId, (keyof MagnifierSettings)[]> = {
  target: ["sourceId", "sourceName"],
  optics: ["radius", "scale", "fps", "smoothing"],
  render: ["renderMode"],
  hotkey: ["showHotkey"],
};

type MessageTone = "idle" | "success" | "error" | "info";

function getAppApi(): Window["api"] | null {
  return "api" in window ? window.api : null;
}

function hotkeyKeys(accelerator: string | null): string[] {
  if (!accelerator) return [];
  return accelerator.split("+").map((part) => {
    if (part === "CommandOrControl" || part === "Control" || part === "Meta" || part === "Command") return "Ctrl";
    if (part.startsWith("Mouse")) return "鼠标" + part.slice(5);
    return part.length === 1 ? part.toUpperCase() : part;
  });
}

function modeShortLabel(renderMode: MagnifierSettings["renderMode"]): string {
  if (renderMode === "canvas2d") return "Canvas 2D";
  if (renderMode === "webgl") return "WebGL";
  return "Native WGC";
}

function SliderField(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  unit: string;
  minLabel: string;
  maxLabel: string;
  hint: string;
  disabled: boolean;
  onChange: (value: number) => void;
}): JSX.Element {
  const percent = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <div className="slider-field">
      <div className="field-head">
        <label htmlFor={props.id}>{props.label}</label>
        <output className="value-badge" htmlFor={props.id}>
          {props.display}
          <span>{props.unit}</span>
        </output>
      </div>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        disabled={props.disabled}
        style={{ "--fill": percent + "%" } as CSSProperties}
      />
      <div className="range-scale" aria-hidden="true">
        <span>{props.minLabel}</span>
        <span>{props.maxLabel}</span>
      </div>
      <p className="hint">{props.hint}</p>
    </div>
  );
}

export function SettingsApp(): JSX.Element {
  const [settings, setSettings] = useState<MagnifierSettings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<MagnifierSettings>(DEFAULT_SETTINGS);
  const [sources, setSources] = useState<CaptureSourceDTO[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<MessageTone>("idle");
  const [activeTab, setActiveTab] = useState<TabId>("target");
  const [showRenderModeInfo, setShowRenderModeInfo] = useState(false);
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [renderModeFeatures, setRenderModeFeatures] = useState<RenderModeFeatures>(DEFAULT_RENDER_MODE_FEATURES);

  const apiAvailable = getAppApi() !== null;
  const escHandlerRef = useRef<((event: KeyboardEvent) => void) | null>(null);
  const modalCloseRef = useRef<HTMLButtonElement | null>(null);

  const expectedDiameter = Math.round(settings.radius * 2 * settings.scale);
  const outputRingSize = Math.round(82 + ((Math.min(8, Math.max(1, settings.scale)) - 1) / 7) * 36);
  const selectedSource = sources.find((source) => source.id === settings.sourceId) ?? null;
  const targetName = selectedSource?.name ?? settings.sourceName;
  const targetIcon = selectedSource?.appIcon ?? null;
  const selectedSourceExists = !settings.sourceId || sources.some((source) => source.id === settings.sourceId);
  const dirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(savedSettings), [settings, savedSettings]);
  const hotkeyPartList = useMemo(() => hotkeyKeys(settings.showHotkey), [settings.showHotkey]);
  const selectedMode = MODE_ITEMS.find((mode) => mode.id === settings.renderMode) ?? MODE_ITEMS[0];

  function isTabDirty(tab: TabId): boolean {
    return DIRTY_KEYS[tab].some((key) => settings[key] !== savedSettings[key]);
  }

  useEffect(() => {
    const api = getAppApi();
    if (!api) {
      setMessage("设置接口未加载，请从 Electron 应用内打开设置面板。");
      setMessageTone("error");
      return;
    }

    let disposed = false;
    Promise.all([api.getSettings(), api.getRenderModeFeatures(), loadSources()])
      .then(([loadedSettings, features]) => {
        if (disposed) return;
        setRenderModeFeatures(features);
        setSettings(loadedSettings);
        setSavedSettings(loadedSettings);
      })
      .catch((error) => {
        console.error(error);
        if (!disposed) {
          setMessage("初始化设置失败，请关闭设置窗口后重试。");
          setMessageTone("error");
        }
      });

    const off = api.onSettingsChanged((nextSettings) => {
      setSettings(nextSettings);
      setSavedSettings(nextSettings);
    });

    return () => {
      disposed = true;
      off();
      if (escHandlerRef.current) {
        window.removeEventListener("keydown", escHandlerRef.current, true);
        escHandlerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!recordingHotkey && escHandlerRef.current) {
      window.removeEventListener("keydown", escHandlerRef.current, true);
      escHandlerRef.current = null;
    }
  }, [recordingHotkey]);

  useEffect(() => {
    if (messageTone !== "success" || !message) return;
    const timer = window.setTimeout(() => {
      setMessage("");
      setMessageTone("idle");
    }, 4200);
    return () => window.clearTimeout(timer);
  }, [message, messageTone]);

  useEffect(() => {
    if (!showRenderModeInfo) return;
    modalCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setShowRenderModeInfo(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showRenderModeInfo]);

  async function loadSources(): Promise<CaptureSourceDTO[]> {
    const api = getAppApi();
    if (!api) {
      setSources([]);
      setMessage("设置接口未加载，请从 Electron 应用内打开设置面板。");
      setMessageTone("error");
      return [];
    }

    setLoadingSources(true);
    setMessage("");
    setMessageTone("idle");

    try {
      const nextSources = await api.getCaptureSources();
      setSources(nextSources);
      return nextSources;
    } catch (error) {
      console.error(error);
      setMessage("读取窗口列表失败。");
      setMessageTone("error");
      return [];
    } finally {
      setLoadingSources(false);
    }
  }

  function patchSettings(patch: Partial<MagnifierSettings>): void {
    setSettings((current) => ({ ...current, ...patch }));
    setMessage("");
    setMessageTone("idle");
  }

  async function save(): Promise<void> {
    const api = getAppApi();
    if (!api) {
      setMessage("设置接口未加载，请从 Electron 应用内打开设置面板。");
      setMessageTone("error");
      return;
    }

    setSaving(true);
    setMessage("");
    setMessageTone("idle");

    try {
      const normalized = await api.setSettings(settings);
      setSettings(normalized);
      setSavedSettings(normalized);
      setMessage("设置已应用");
      setMessageTone("success");
    } catch (error) {
      console.error(error);
      setMessage(
        settings.renderMode === "native-wgc"
          ? "Native WGC 启动失败，请确认目标窗口仍然打开，且系统支持窗口捕获后重试。"
          : "保存设置失败。",
      );
      setMessageTone("error");
    } finally {
      setSaving(false);
    }
  }

  async function reset(): Promise<void> {
    const api = getAppApi();
    if (!api) {
      setMessage("设置接口未加载，请从 Electron 应用内打开设置面板。");
      setMessageTone("error");
      return;
    }

    try {
      const loaded = await api.getSettings();
      setSettings(loaded);
      setSavedSettings(loaded);
      setMessage("");
      setMessageTone("idle");
    } catch (error) {
      console.error(error);
      setMessage("还原设置失败。");
      setMessageTone("error");
    }
  }

  function onSourceChange(sourceId: string): void {
    const source = sources.find((item) => item.id === sourceId);
    patchSettings({
      sourceId: source?.id ?? null,
      sourceName: source?.name ?? null,
    });
  }

  function onFpsChange(fps: MagnifierSettings["fps"]): void {
    patchSettings({ fps });
  }

  async function startRecordingHotkey(): Promise<void> {
    const api = getAppApi();
    if (!api || recordingHotkey) return;
    setRecordingHotkey(true);

    const escHandler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        api.cancelHotkeyRecording();
        setRecordingHotkey(false);
      }
    };
    escHandlerRef.current = escHandler;
    window.addEventListener("keydown", escHandler, true);

    try {
      const accelerator = await api.startHotkeyRecording();
      if (accelerator) {
        patchSettings({ showHotkey: accelerator });
      }
    } finally {
      setRecordingHotkey(false);
    }
  }

  const statusTone: MessageTone = message
    ? messageTone
    : !apiAvailable
      ? "error"
      : !settings.sourceId
        ? "info"
        : dirty
          ? "info"
          : "idle";

  const statusText = message
    ? message
    : !apiAvailable
      ? "设置接口未加载"
      : !settings.sourceId
        ? "先在「目标窗口」中选择一个窗口，才能应用设置。"
        : dirty
          ? "有未应用的更改，点击「应用设置」写入配置。"
          : "所有更改已保存。";

  function renderTargetView(): JSX.Element {
    return (
      <div className="view">
        <section className="panel">
          <header className="panel-head">
            <span className="panel-badge">
              <Icon name="target" size={21} />
            </span>
            <div className="panel-title">
              <h2>取景源</h2>
              <p>放大镜取目标窗口的中心圆形区域。</p>
            </div>
            <span className="panel-index">01 / 04</span>
          </header>

          <div className="panel-body target-grid">
            <div className="target-fields">
              <div className="field">
                <div className="field-head">
                  <label htmlFor="source">目标窗口</label>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => void loadSources()}
                    disabled={loadingSources || !apiAvailable}
                  >
                    <Icon name="refresh" size={13} className={loadingSources ? "spin" : undefined} />
                    {loadingSources ? "读取中" : "刷新列表"}
                  </button>
                </div>
                <div className="select-shell">
                  <select
                    id="source"
                    value={settings.sourceId ?? ""}
                    onChange={(event) => onSourceChange(event.target.value)}
                    disabled={!apiAvailable}
                  >
                    <option value="">选择目标窗口</option>
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                    {settings.sourceId && !selectedSourceExists ? (
                      <option value={settings.sourceId} disabled>
                        {settings.sourceName ?? "已关闭的窗口"}（已关闭）
                      </option>
                    ) : null}
                  </select>
                  <Icon name="chevron" size={16} className="select-caret" />
                </div>
                <p className="hint">目标应用需保持打开；窗口关闭后请刷新列表重新选择。</p>
              </div>

              <div className={"source-card" + (targetName ? "" : " is-empty")}>
                <span className="source-avatar">
                  {targetIcon ? <img src={targetIcon} alt="" /> : <Icon name={targetName ? "window" : "lens"} size={19} />}
                </span>
                <span className="source-copy">
                  <strong>{targetName ?? "未选择窗口"}</strong>
                  <span>
                    {!selectedSourceExists
                      ? "目标窗口可能已关闭，请刷新列表"
                      : targetName
                        ? "实时窗口捕获 · 中心圆形裁剪"
                        : "从上方列表选择一个正在运行的应用"}
                  </span>
                </span>
                {targetName ? (
                  <span className={"tag " + (selectedSourceExists ? "tag--accent" : "tag--warn")}>
                    {selectedSourceExists ? "取景源" : "已关闭"}
                  </span>
                ) : null}
              </div>

              {!selectedSourceExists ? (
                <div className="notice notice--warn">
                  <Icon name="alert" size={15} />
                  <span>保存的窗口不在列表中，目标应用可能已关闭。请刷新后重新选择。</span>
                </div>
              ) : null}

              <div className="target-stats">
                <div className="stat">
                  <span>裁剪直径</span>
                  <strong>
                    {settings.radius * 2}
                    <small>px</small>
                  </strong>
                </div>
                <div className="stat">
                  <span>输出边长</span>
                  <strong>
                    {expectedDiameter}
                    <small>px</small>
                  </strong>
                </div>
                <div className="stat">
                  <span>帧率</span>
                  <strong>
                    {settings.fps}
                    <small>FPS</small>
                  </strong>
                </div>
              </div>

              <div className="panel-foot">
                <div className="section-label">小贴士</div>
                <div className="tip">
                  <Icon name="info" size={15} />
                  <span>放大镜窗口置顶显示并忽略鼠标操作，不会挡住目标应用的操作。</span>
                </div>
              </div>
            </div>

            <div className={"crop-card" + (targetName ? "" : " is-empty")} aria-hidden="true">
              <div className="crop-frame">
                <div className="crop-topbar">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="crop-canvas">
                  <span className="crop-window">
                    <span className="cw-bar">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="cw-body">
                      <span className="cw-side">
                        <b />
                        <b />
                        <b />
                        <b />
                      </span>
                      <span className="cw-main">
                        <b className="cw-line cw-line--wide" />
                        <b className="cw-line cw-line--full" />
                        <b className="cw-line cw-line--mid" />
                        <b className="cw-line cw-line--wide" />
                        <b className="cw-line cw-line--short" />
                      </span>
                    </span>
                  </span>
                  <span className="crop-circle">
                    {targetIcon ? (
                      <img src={targetIcon} alt="" />
                    ) : (
                      <Icon name={targetName ? "window" : "lens"} size={26} />
                    )}
                  </span>
                </div>
                <span className="crop-radius">r = {settings.radius} px</span>
              </div>
              <div className="crop-caption">
                <span className="dot" />
                {targetName ? "中心圆形取景" : "等待选择窗口"}
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  function renderOpticsView(): JSX.Element {
    return (
      <div className="view">
        <section className="panel">
          <header className="panel-head">
            <span className="panel-badge">
              <Icon name="sliders" size={21} />
            </span>
            <div className="panel-title">
              <h2>放大参数</h2>
              <p>调整取景半径、倍率与帧率，控制画面范围与流畅度。</p>
            </div>
            <span className="panel-index">02 / 04</span>
          </header>

          <div className="panel-body">
            <div className="slider-grid">
              <SliderField
                id="radius"
                label="捕获半径"
                value={settings.radius}
                min={40}
                max={600}
                step={10}
                display={String(settings.radius)}
                unit="px"
                minLabel="40"
                maxLabel="600"
                hint="实际裁剪区域直径为半径的 2 倍。"
                disabled={!apiAvailable}
                onChange={(radius) => patchSettings({ radius })}
              />
              <SliderField
                id="scale"
                label="缩放比例"
                value={settings.scale}
                min={1}
                max={8}
                step={0.1}
                display={settings.scale.toFixed(1)}
                unit="x"
                minLabel="1.0x"
                maxLabel="8.0x"
                hint="放大镜窗口边长 = 半径 × 2 × 缩放。"
                disabled={!apiAvailable}
                onChange={(scale) => patchSettings({ scale })}
              />
            </div>

            <div className="panel-divider" />

            <div className="optics-bottom">
              <div className="field">
                <div className="field-head">
                  <label>帧率</label>
                  <span className="field-note">越高越流畅</span>
                </div>
                <div className="segmented" role="group" aria-label="帧率">
                  {FPS_OPTIONS.map((fps) => (
                    <button
                      key={fps}
                      type="button"
                      aria-pressed={settings.fps === fps}
                      onClick={() => onFpsChange(fps)}
                      disabled={!apiAvailable}
                    >
                      {fps}
                      <span className="seg-unit">FPS</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="toggle-card">
                <div className="toggle-copy">
                  <strong>图像平滑</strong>
                  <span>插值柔化放大后的边缘</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="图像平滑"
                    checked={settings.smoothing}
                    onChange={(event) => patchSettings({ smoothing: event.target.checked })}
                    disabled={!apiAvailable}
                  />
                  <span className="switch-track">
                    <span className="switch-knob" />
                  </span>
                </label>
              </div>
            </div>

            <div className="panel-foot">
              <div className="section-label">几何关系</div>
              <div className="optics-geometry">
                <div className="geom-side">
                  <span className="geom-label">取景圆</span>
                  <span className="geom-ring geom-ring--crop">
                    <span className="geom-cross" />
                  </span>
                  <strong>
                    {settings.radius * 2}
                    <small>px</small>
                  </strong>
                </div>

                <div className="geom-op">
                  <span>×</span>
                  <strong>{settings.scale.toFixed(1)}</strong>
                </div>

                <div className="geom-side">
                  <span className="geom-label">输出圆</span>
                  <span
                    className="geom-ring geom-ring--out"
                    style={{ "--ring": outputRingSize + "px" } as CSSProperties}
                  >
                    <span className="geom-gloss" />
                  </span>
                  <strong>
                    {expectedDiameter}
                    <small>px</small>
                  </strong>
                </div>

                <div className="geom-note">
                  <span className="geom-note-title">屏幕中心 · 置顶显示</span>
                  <span>
                    输出窗口 {expectedDiameter} × {expectedDiameter} px
                  </span>
                  <span className="geom-formula">半径 × 2 × 缩放</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  function renderRenderView(): JSX.Element {
    return (
      <div className="view">
        <section className="panel">
          <header className="panel-head">
            <span className="panel-badge">
              <Icon name="layers" size={21} />
            </span>
            <div className="panel-title">
              <h2>渲染管线</h2>
              <p>选择捕获与放大所使用的方式，兼容性与开销各不相同。</p>
            </div>
            <span className="panel-index">03 / 04</span>
          </header>

          <div className="panel-body">
            <div className="mode-list" role="radiogroup" aria-label="渲染模式">
              {MODE_ITEMS.map((mode) => {
                const available = renderModeFeatures[mode.featureKey];
                const selected = settings.renderMode === mode.id;
                return (
                  <label
                    key={mode.id}
                    className={"mode-card" + (selected ? " is-selected" : "") + (available ? "" : " is-disabled")}
                  >
                    <input
                      type="radio"
                      name="renderMode"
                      value={mode.id}
                      checked={selected}
                      disabled={!available || !apiAvailable}
                      onChange={() => patchSettings({ renderMode: mode.id })}
                    />
                    <span className="mode-icon">
                      <Icon name={mode.icon} size={19} />
                    </span>
                    <span className="mode-copy">
                      <span className="mode-title">
                        {mode.label}
                        <span className={"tag " + (available ? (mode.tag === "兼容" ? "tag--ok" : "tag--soft") : "tag--off")}>
                          {available ? mode.tag : "暂不可用"}
                        </span>
                      </span>
                      <span className="mode-desc">{mode.desc}</span>
                    </span>
                    <span className="mode-radio" aria-hidden="true" />
                  </label>
                );
              })}
            </div>

            <div className="render-foot">
              <p className="hint">开发环境启用 Native WGC 前，需先编译原生模块。</p>
              <button type="button" className="link-btn" onClick={() => setShowRenderModeInfo(true)}>
                <Icon name="info" size={14} />
                对比渲染模式
              </button>
            </div>

            <div className="panel-foot">
              <div className="section-label">管线路径</div>
              <div className="pipeline">
                <div className="pipeline-step">
                  <span className="pipeline-num">01</span>
                  <span className="pipeline-label">捕获</span>
                  <strong>{selectedMode.summary.capture}</strong>
                </div>
                <span className="pipeline-arrow" aria-hidden="true">
                  <Icon name="chevron" size={15} />
                </span>
                <div className="pipeline-step">
                  <span className="pipeline-num">02</span>
                  <span className="pipeline-label">裁剪</span>
                  <strong>{selectedMode.summary.crop}</strong>
                </div>
                <span className="pipeline-arrow" aria-hidden="true">
                  <Icon name="chevron" size={15} />
                </span>
                <div className="pipeline-step">
                  <span className="pipeline-num">03</span>
                  <span className="pipeline-label">输出</span>
                  <strong>{selectedMode.summary.output}</strong>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  function renderHotkeyView(): JSX.Element {
    return (
      <div className="view">
        <section className="panel">
          <header className="panel-head">
            <span className="panel-badge">
              <Icon name="keyboard" size={21} />
            </span>
            <div className="panel-title">
              <h2>快捷键</h2>
              <p>设置一个全局组合键，在任何窗口中切换放大镜的显示。</p>
            </div>
            <span className="panel-index">04 / 04</span>
          </header>

          <div className="panel-body">
            <div className="hotkey-main">
              <div className={"hotkey-pad" + (recordingHotkey ? " is-recording" : "")}>
                <div className="keycaps">
                  {recordingHotkey ? (
                    <span className="recording-label">
                      正在聆听按键
                      <span className="recording-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    </span>
                  ) : hotkeyPartList.length > 0 ? (
                    hotkeyPartList.map((keyPart, index) => (
                      <span className="key-group" key={keyPart + "-" + index}>
                        {index > 0 ? <span className="key-plus">+</span> : null}
                        <kbd className="keycap">{keyPart}</kbd>
                      </span>
                    ))
                  ) : (
                    <span className="keycap keycap--empty">未设置</span>
                  )}
                </div>
                {recordingHotkey ? (
                  <span className="recording-chip">ESC 取消</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm btn--soft"
                    onClick={() => void startRecordingHotkey()}
                    disabled={!apiAvailable}
                  >
                    录制
                  </button>
                )}
              </div>
              <p className="hint">
                {recordingHotkey
                  ? "按下任意组合键完成录制，按 ESC 取消。"
                  : "在其他窗口中按下此组合键，即可切换放大镜的显示。"}
              </p>

              <div className="hotkey-info">
                <div className="hotkey-info-row">
                  <span className="hotkey-info-icon">
                    <Icon name="target" size={15} />
                  </span>
                  <div>
                    <strong>全局监听</strong>
                    <span>不依赖窗口焦点，在任何应用中都能触发。</span>
                  </div>
                </div>
                <div className="hotkey-info-row">
                  <span className="hotkey-info-icon">
                    <Icon name="check" size={15} />
                  </span>
                  <div>
                    <strong>保存后生效</strong>
                    <span>修改快捷键后，需点击「应用设置」写入配置。</span>
                  </div>
                </div>
                <div className="hotkey-info-row">
                  <span className="hotkey-info-icon">
                    <Icon name="alert" size={15} />
                  </span>
                  <div>
                    <strong>组合键冲突</strong>
                    <span>若组合键被其他软件占用，请更换一组按键。</span>
                  </div>
                </div>
              </div>

              <div className="panel-foot">
                <div className="section-label">使用流程</div>
                <ol className="steps">
                  <li>
                    <span className="step-num">1</span>
                    <div>
                      <strong>录制</strong>
                      <span>点击录制并按下组合键</span>
                    </div>
                  </li>
                  <li>
                    <span className="step-num">2</span>
                    <div>
                      <strong>应用</strong>
                      <span>点击「应用设置」写入配置</span>
                    </div>
                  </li>
                  <li>
                    <span className="step-num">3</span>
                    <div>
                      <strong>使用</strong>
                      <span>在任意窗口切换放大镜</span>
                    </div>
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <img src={appIcon} alt="" />
          </span>
          <span className="brand-name">Centre Magnifying</span>
          <span className="brand-sep" />
          <span className="brand-page">设置</span>
        </div>
      </header>

      <div className="app">
        <aside className="rail">
          <div className="rail-label">设置分类</div>
          <nav className="nav" aria-label="设置分类">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={"nav-item" + (activeTab === tab.id ? " is-active" : "")}
                onClick={() => setActiveTab(tab.id)}
                aria-current={activeTab === tab.id ? "page" : undefined}
              >
                <Icon name={tab.icon} size={18} />
                <span>{tab.label}</span>
                {isTabDirty(tab.id) ? (
                  <span className="nav-dirty" title="有未应用的修改" />
                ) : (
                  <span className="nav-index">{tab.index}</span>
                )}
              </button>
            ))}
          </nav>

          <div className="rail-preview">
            <div className="rail-preview-label">镜头预览</div>
            <div className="lens" aria-hidden="true">
              <span className="lens-ticks" />
              <span className="lens-cross" />
            </div>
            <div className="rail-readout">
              {expectedDiameter}
              <small>px</small>
            </div>
            <div className="rail-meta">
              <span>{settings.radius} 半径</span>
              <span className="sep" />
              <span>{settings.scale.toFixed(1)}x</span>
            </div>
            <div className="rail-meta rail-meta--dim">
              <span>{settings.fps} FPS</span>
              <span className="sep" />
              <span>{modeShortLabel(settings.renderMode)}</span>
            </div>
          </div>
        </aside>

        <main className="content">
          <div className="page-head">
            <div className="page-head-copy">
              <div className="eyebrow">Centre Magnifying</div>
              <h1>放大镜设置</h1>
              <p>调校取景、倍率与渲染管线；更改在点击「应用设置」后生效。</p>
            </div>
            <div className={"sync-chip" + (dirty ? " is-dirty" : "") + (!apiAvailable ? " is-error" : "")}>
              <span className="sync-dot" />
              {!apiAvailable ? "接口未连接" : dirty ? "有未应用的更改" : "已保存"}
            </div>
          </div>

          {activeTab === "target" ? renderTargetView() : null}
          {activeTab === "optics" ? renderOpticsView() : null}
          {activeTab === "render" ? renderRenderView() : null}
          {activeTab === "hotkey" ? renderHotkeyView() : null}
        </main>

        <footer className="actionbar">
          <div className={"status status--" + statusTone} role="status" aria-live="polite">
            {statusTone === "idle" ? (
              <span className="status-dot" />
            ) : (
              <Icon
                name={statusTone === "success" ? "check" : statusTone === "error" ? "alert" : "info"}
                size={15}
              />
            )}
            <span>{statusText}</span>
          </div>
          <div className="action-buttons">
            <button
              type="button"
              className="btn btn--soft"
              onClick={() => void reset()}
              disabled={!apiAvailable || !dirty}
              title="放弃未保存的修改，恢复为已保存的设置"
            >
              撤销修改
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void save()}
              disabled={saving || !settings.sourceId || !apiAvailable}
              title={!settings.sourceId ? "请先选择目标窗口" : undefined}
            >
              {saving ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={15} />}
              {saving ? "应用中" : "应用设置"}
            </button>
          </div>
        </footer>
      </div>

      {showRenderModeInfo ? (
        <div className="modal-overlay" onClick={() => setShowRenderModeInfo(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="render-mode-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <h2 id="render-mode-title">渲染模式对比</h2>
                <p className="modal-sub">三种管线共用同一组放大参数，差别在捕获路径与绘制方式。</p>
              </div>
              <button
                ref={modalCloseRef}
                type="button"
                className="icon-btn"
                onClick={() => setShowRenderModeInfo(false)}
                aria-label="关闭"
              >
                <Icon name="close" size={17} />
              </button>
            </div>

            <table className="compare-table">
              <thead>
                <tr>
                  <th />
                  <th>Canvas 2D</th>
                  <th>
                    <span className="mode-heading">
                      WebGL
                      {!renderModeFeatures.webgl ? <span className="mode-chip">暂不可用</span> : null}
                    </span>
                  </th>
                  <th>
                    <span className="mode-heading">
                      Native WGC
                      {!renderModeFeatures.nativeWgc ? <span className="mode-chip">暂不可用</span> : null}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>渲染引擎</td>
                  <td>浏览器 Canvas 2D</td>
                  <td>WebGL 纹理与着色器</td>
                  <td>GPU D3D11 + HLSL</td>
                </tr>
                <tr>
                  <td>捕获管线</td>
                  <td>Chromium MediaStream</td>
                  <td>Chromium MediaStream</td>
                  <td>Windows.Graphics.Capture 直通</td>
                </tr>
                <tr>
                  <td>裁剪方式</td>
                  <td>Canvas 圆形裁剪</td>
                  <td>Canvas 中心裁剪 + 圆形遮罩</td>
                  <td>窗口区域圆形遮罩</td>
                </tr>
                <tr>
                  <td>数据路径</td>
                  <td>视频绘制到 Canvas</td>
                  <td>中间 Canvas → WebGL 纹理</td>
                  <td>GPU 内全流程，无 Chromium 层</td>
                </tr>
                <tr>
                  <td>帧同步</td>
                  <td>视频帧回调，或 RAF 回退</td>
                  <td>视频帧回调，或 RAF 回退</td>
                  <td>WGC FrameArrived 原生回调</td>
                </tr>
                <tr>
                  <td>延迟</td>
                  <td>取决于设备和捕获源</td>
                  <td>取决于设备和捕获源</td>
                  <td>取决于设备和捕获源</td>
                </tr>
                <tr>
                  <td>兼容性</td>
                  <td>全平台</td>
                  <td>需 WebGL 支持</td>
                  <td>Windows 10 1903 或更新版本</td>
                </tr>
              </tbody>
            </table>

            <p className="modal-note">
              Canvas 2D 和 WebGL 使用相同的 Desktop Capture 捕获管线，渲染方式不同。WebGL 使用中间 Canvas
              保持捕获兼容性，平滑放大时采用立方重建滤镜。Native WGC 使用独立的 Windows 窗口捕获与 D3D11
              渲染管线。实际帧率与延迟需在目标设备和应用中测量。
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn--primary" onClick={() => setShowRenderModeInfo(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

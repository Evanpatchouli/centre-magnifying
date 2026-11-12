import { useEffect, useMemo, useRef, useState } from "react";
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

function getAppApi(): Window["api"] | null {
  return "api" in window ? window.api : null;
}

export function SettingsApp(): JSX.Element {
  const [maximized, setMaximized] = useState(false);
  const [settings, setSettings] = useState<MagnifierSettings>(DEFAULT_SETTINGS);
  const [sources, setSources] = useState<CaptureSourceDTO[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [showRenderModeInfo, setShowRenderModeInfo] = useState(false);
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [renderModeFeatures, setRenderModeFeatures] = useState<RenderModeFeatures>(DEFAULT_RENDER_MODE_FEATURES);

  const apiAvailable = getAppApi() !== null;

  useEffect(() => {
    const api = getAppApi();
    if (!api) {
      setMessage("设置接口未加载，请从 Electron 应用内打开设置面板。");
      return;
    }

    let disposed = false;
    void api.isWindowMaximized().then((value) => { if (!disposed) setMaximized(value); });
    const offMaximized = api.onWindowMaximized(setMaximized);

    Promise.all([api.getSettings(), api.getRenderModeFeatures(), loadSources()])
      .then(([loadedSettings, features]) => {
        if (disposed) return;
        setRenderModeFeatures(features);
        setSettings(loadedSettings);
      })
      .catch((error) => {
        console.error(error);
        if (!disposed) {
          setMessage("初始化设置失败，请关闭设置窗口后重试。");
        }
      });

    const off = api.onSettingsChanged((nextSettings) => {
      setSettings(nextSettings);
    });

    return () => {
      disposed = true;
      off();
      offMaximized();
      // Clean up hotkey recording ESC listener if active
      if (escHandlerRef.current) {
        window.removeEventListener('keydown', escHandlerRef.current, true);
      }
    };
  }, []);

  // Clean up ESC listener when recording switches off
  useEffect(() => {
    if (!recordingHotkey && escHandlerRef.current) {
      window.removeEventListener('keydown', escHandlerRef.current, true);
      escHandlerRef.current = null;
    }
  }, [recordingHotkey]);

  const selectedSourceExists = useMemo(() => {
    if (!settings.sourceId) return true;
    return sources.some((source) => source.id === settings.sourceId);
  }, [settings.sourceId, sources]);

  async function loadSources(): Promise<CaptureSourceDTO[]> {
    const api = getAppApi();
    if (!api) {
      setSources([]);
      setMessage("设置接口未加载，请从 Electron 应用内打开设置面板。");
      return [];
    }

    setLoadingSources(true);
    setMessage("");

    try {
      const nextSources = await api.getCaptureSources();
      setSources(nextSources);
      return nextSources;
    } catch (error) {
      console.error(error);
      setMessage("读取窗口列表失败。");
      return [];
    } finally {
      setLoadingSources(false);
    }
  }

  function patchSettings(patch: Partial<MagnifierSettings>): void {
    setSettings((current) => ({ ...current, ...patch }));
  }

  async function save(): Promise<void> {
    const api = getAppApi();
    if (!api) {
      setMessage("设置接口未加载，请从 Electron 应用内打开设置面板。");
      return;
    }

    setSaving(true);
    setMessage("");

    try {
      const normalized = await api.setSettings(settings);
      setSettings(normalized);
      setMessage("设置已应用。");
    } catch (error) {
      console.error(error);
      setMessage(settings.renderMode === 'native-wgc'
        ? "Native WGC 启动失败，请确认目标窗口仍然打开，且系统支持窗口捕获后重试。"
        : "保存设置失败。");
    } finally {
      setSaving(false);
    }
  }

  async function reset(): Promise<void> {
    const api = getAppApi();
    if (!api) {
      setMessage("设置接口未加载，请从 Electron 应用内打开设置面板。");
      return;
    }

    try {
      setSettings(await api.getSettings());
      setMessage("");
    } catch (error) {
      console.error(error);
      setMessage("还原设置失败。");
    }
  }

  function onSourceChange(sourceId: string): void {
    const source = sources.find((item) => item.id === sourceId);
    patchSettings({
      sourceId: source?.id ?? null,
      sourceName: source?.name ?? null,
    });
  }

  function renderModeLabel(renderMode: MagnifierSettings['renderMode']): string {
    if (renderMode === 'canvas2d') return 'Canvas 2D（兼容模式）';
    if (renderMode === 'webgl') {
      return renderModeFeatures.webgl
        ? 'WebGL（实验模式）'
        : 'WebGL（实验模式，暂不开放）';
    }

    return renderModeFeatures.nativeWgc
      ? 'Native WGC（实验模式）'
      : 'Native WGC（实验模式，暂不开放）';
  }

  function formatHotkey(accelerator: string | null): string {
    if (!accelerator) return "未设置";
    return accelerator
      .replace('CommandOrControl', 'Ctrl')
      .replace('Shift', 'Shift')
      .replace('Alt', 'Alt')
  }

  // DOM keydown handler only for ESC cancellation during IPC recording
  const escHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  async function startRecordingHotkey(): Promise<void> {
    const api = getAppApi();
    if (!api || recordingHotkey) return;
    setRecordingHotkey(true);

    // Listen for ESC locally to cancel the IPC recording
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        api.cancelHotkeyRecording();
        setRecordingHotkey(false);
      }
    };
    escHandlerRef.current = escHandler;
    window.addEventListener('keydown', escHandler, true);

    // Start recording via main process (uiohook captures globally)
    const accelerator = await api.startHotkeyRecording();
    setRecordingHotkey(false);

    if (accelerator) {
      patchSettings({ showHotkey: accelerator });
    }
  }

  return (
    <>
    <header className="titlebar">
      <div className="titlebar-brand"><img src={appIcon} alt="" /><span>Centre Magnifying</span><span className="titlebar-section">设置</span></div>
      <div className="window-controls">
        <button type="button" className="window-control" aria-label="最小化" title="最小化" onClick={() => void getAppApi()?.controlWindow('minimize')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg></button>
        <button type="button" className="window-control" aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} onClick={() => void getAppApi()?.controlWindow('toggle-maximize')}><svg viewBox="0 0 16 16" aria-hidden="true">{maximized ? <path d="M5 4V2.5h8.5V11H12M2.5 5h9v8.5h-9z" /> : <path d="M3 3h10v10H3z" />}</svg></button>
        <button type="button" className="window-control window-close" aria-label="关闭" title="关闭" onClick={() => void getAppApi()?.controlWindow('close')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
      </div>
    </header>
    <main className="page">
      <section className="card">
        <h1>Centre Magnifying 设置</h1>
        <p className="description">
          选择一个目标应用窗口，软件会捕获该窗口内容，并把目标窗口中心区域裁剪成圆形后实时放大显示在屏幕中心。
        </p>

        <div className="form">
          <div className="field">
            <div className="field-row">
              <label htmlFor="source">目标窗口</label>
              <button
                type="button"
                className="secondary"
                onClick={() => void loadSources()}
                disabled={loadingSources || !apiAvailable}
              >
                {loadingSources ? "刷新中..." : "刷新窗口列表"}
              </button>
            </div>
            <select
              id="source"
              value={settings.sourceId ?? ""}
              onChange={(event) => onSourceChange(event.target.value)}
              disabled={!apiAvailable}
            >
              <option value="">请选择目标窗口</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
            {!selectedSourceExists ? (
              <div className="hint">当前保存的窗口不在列表中，目标应用可能已关闭，请刷新后重新选择。</div>
            ) : null}
          </div>

          <div className="field">
            <div className="field-row">
              <label htmlFor="radius">捕获半径</label>
              <span className="value">{settings.radius}px</span>
            </div>
            <input
              id="radius"
              type="range"
              min={40}
              max={600}
              step={10}
              value={settings.radius}
              onChange={(event) => patchSettings({ radius: Number(event.target.value) })}
              disabled={!apiAvailable}
            />
            <div className="hint">实际裁剪区域直径为半径的 2 倍，以目标窗口视频流中心为圆心。</div>
          </div>

          <div className="field">
            <div className="field-row">
              <label htmlFor="scale">缩放比例</label>
              <span className="value">{settings.scale.toFixed(1)}x</span>
            </div>
            <input
              id="scale"
              type="range"
              min={1}
              max={8}
              step={0.1}
              value={settings.scale}
              onChange={(event) => patchSettings({ scale: Number(event.target.value) })}
              disabled={!apiAvailable}
            />
            <div className="hint">放大镜窗口大小 = 捕获半径 x 2 x 缩放比例。</div>
          </div>

          <div className="field">
            <label htmlFor="fps">帧率</label>
            <select
              id="fps"
              value={settings.fps}
              onChange={(event) => patchSettings({ fps: Number(event.target.value) })}
              disabled={!apiAvailable}
            >
              {FPS_OPTIONS.map((fps) => (
                <option key={fps} value={fps}>
                  {fps} FPS
                </option>
              ))}
            </select>
          </div>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.smoothing}
              onChange={(event) => patchSettings({ smoothing: event.target.checked })}
              disabled={!apiAvailable}
            />
            图像平滑放大
          </label>

          <div className="field">
            <div className="field-row">
              <label htmlFor="renderMode">渲染模式</label>
              <button
                type="button"
                className="info-button"
                onClick={() => setShowRenderModeInfo(true)}
                title="了解渲染模式区别"
              >
                ?
              </button>
            </div>
            <select
              id="renderMode"
              value={settings.renderMode}
              onChange={(event) => patchSettings({ renderMode: event.target.value as MagnifierSettings['renderMode'] })}
              disabled={!apiAvailable}
            >
              <option value="canvas2d">{renderModeLabel('canvas2d')}</option>
              <option value="webgl" disabled={!renderModeFeatures.webgl}>{renderModeLabel('webgl')}</option>
              <option value="native-wgc" disabled={!renderModeFeatures.nativeWgc}>{renderModeLabel('native-wgc')}</option>
            </select>
            <div className="hint">Native WGC 使用 Windows 原生窗口捕获与渲染；开发环境需先编译原生模块。</div>
          </div>

          {showRenderModeInfo ? (
            <div className="modal-overlay" onClick={() => setShowRenderModeInfo(false)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2>渲染模式对比</h2>
                <table className="compare-table">
                  <thead>
                    <tr>
                      <th></th>
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
                  Canvas 2D 和 WebGL 使用相同的 Desktop Capture 捕获管线，渲染方式不同。
                  WebGL 使用中间 Canvas 保持捕获兼容性，平滑放大时采用立方重建滤镜。
                  Native WGC 使用独立的 Windows 窗口捕获与 D3D11 渲染管线。
                  实际帧率与延迟需在目标设备和应用中测量。
                </p>
                <div className="modal-actions">
                  <button type="button" onClick={() => setShowRenderModeInfo(false)}>
                    知道了
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="field">
            <div className="field-row">
              <label htmlFor="showHotkey">显示/隐藏热键</label>
            </div>
            <div className="field-row">
              <span className="hotkey-badge">{formatHotkey(settings.showHotkey)}</span>
              <button
                type="button"
                className={recordingHotkey ? 'danger' : 'secondary'}
                onClick={startRecordingHotkey}
                disabled={!apiAvailable}
              >
                {recordingHotkey ? '按下快捷键... ESC 取消' : '录制'}
              </button>
            </div>
            <div className="hint">在任何窗口中按下此快捷键切换放大镜的显示和隐藏。需先"应用设置"方可生效。</div>
          </div>

          {message ? <div className="hint">{message}</div> : null}

          <div className="actions">
            <button type="button" className="secondary" onClick={() => void reset()} disabled={!apiAvailable}>
              还原未保存修改
            </button>
            <button type="button" onClick={() => void save()} disabled={saving || !settings.sourceId || !apiAvailable}>
              {saving ? "应用中..." : "应用设置"}
            </button>
          </div>
        </div>
      </section>
    </main>
    </>
  );
}

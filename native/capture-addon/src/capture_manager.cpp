#include "capture_manager.h"

#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#pragma comment(lib, "dxguid.lib")

namespace wgc {
namespace {

/* ==================================================================
 *  HLSL Shaders
 * ================================================================*/

const char* g_vsSrc = R"(
struct VSIn  { float2 p : POSITION; float2 t : TEXCOORD; };
struct PSIn  { float4 p : SV_POSITION;  float2 t : TEXCOORD; };
PSIn main(VSIn v) { PSIn o; o.p = float4(v.p, 0, 1); o.t = v.t; return o; }
)";

const char* g_psSrc = R"(
Texture2D    tex    : register(t0);
SamplerState samp   : register(s0);
cbuffer CB  : register(b0) { float2 scale; float2 offset; }
struct PSIn { float4 p : SV_POSITION; float2 t : TEXCOORD; };
float4 main(PSIn i) : SV_TARGET {
  float4 color = tex.Sample(samp, offset + i.t * scale);
  color.a = 1.0;
  return color;
}
)";

/* ── Full-screen quad ─────────────────────────────────────────── */

struct Vertex { float x, y, u, v; };
const Vertex g_quad[6] = {
  {-1,-1,0,1}, {-1,1,0,0}, {1,-1,1,1},
  { 1,-1,1,1}, {-1,1,0,0}, {1,1,1,0},
};

struct alignas(16) CBData { float sx, sy, ox, oy; };

constexpr const wchar_t* kWC = L"CentreMagNativeOverlay";

bool ProbeEnabled() {
  const char* value = std::getenv("CENTRE_MAGNIFYING_NATIVE_WGC_PROBE_LOGS");
  if (!value) return false;
  return _stricmp(value, "1") == 0 ||
         _stricmp(value, "true") == 0 ||
         _stricmp(value, "yes") == 0 ||
         _stricmp(value, "on") == 0;
}

void Probe(const char* event) {
  if (!ProbeEnabled()) return;
  std::fprintf(stderr, "[native-wgc-probe] %s\n", event);
}

void ProbeHr(const char* event, HRESULT hr) {
  if (!ProbeEnabled()) return;
  std::fprintf(stderr, "[native-wgc-probe] %s hr=0x%08lX\n", event, static_cast<unsigned long>(hr));
}

void ProbeStart(HWND hwnd, int outputSize) {
  if (!ProbeEnabled()) return;
  std::fprintf(
    stderr,
    "[native-wgc-probe] start hwnd=%p outputSize=%d\n",
    hwnd,
    outputSize);
}

void ProbeFrame(unsigned long long frameCount, UINT width, UINT height, DXGI_FORMAT format) {
  if (!ProbeEnabled()) return;
  if (frameCount != 1 && frameCount % 60 != 0) return;
  std::fprintf(
    stderr,
    "[native-wgc-probe] frame-arrived count=%llu width=%u height=%u format=%u\n",
    frameCount,
    width,
    height,
    static_cast<unsigned int>(format));
}

void ProbeRender(
  unsigned long long renderCount,
  int vw,
  int vh,
  int sx,
  int sy,
  int sf,
  HRESULT presentHr) {
  if (!ProbeEnabled()) return;
  if (renderCount != 1 && renderCount % 60 != 0) return;
  std::fprintf(
    stderr,
    "[native-wgc-probe] render count=%llu frame=%dx%d crop=(%d,%d,%d) present=0x%08lX\n",
    renderCount,
    vw,
    vh,
    sx,
    sy,
    sf,
    static_cast<unsigned long>(presentHr));
}

} // anonymous namespace

/* ==================================================================
 *  CaptureManager
 * ================================================================*/

CaptureManager::~CaptureManager() { Stop(); }

/* ── Start / Stop / Update ──────────────────────────────────── */

bool CaptureManager::Start(HWND targetHwnd, const RenderParams& params) {
  if (m_running.load()) return false;
  { std::lock_guard<std::mutex> lk(m_paramsMutex); m_params = params; }
  m_renderCount.store(0);
  m_settingsVersion.store(1);
  m_lastRenderedFrame = m_lastRenderedSettings = 0;
  m_visible.store(true);

  m_targetHwnd = targetHwnd;
  if (!IsWindow(targetHwnd)) {
    Probe("start failed: invalid target window");
    return false;
  }
  m_hInstance = GetModuleHandleW(nullptr);
  m_outputSize = OutputSize(params);
  m_desiredOutputSize.store(m_outputSize);
  ProbeStart(targetHwnd, m_outputSize);

  try {
    if (!CreateOverlayWindow() || !InitD3D11() || !InitWgcCapture()) {
      Cleanup();
      return false;
    }
  } catch (const winrt::hresult_error& error) {
    ProbeHr("start failed: WinRT", error.code());
    Cleanup();
    return false;
  } catch (...) {
    Probe("start failed: unexpected exception");
    Cleanup();
    return false;
  }

  m_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!m_stopEvent) { Cleanup(); return false; }
  m_running.store(true);
  m_renderThread = CreateThread(nullptr, 0,
    [](void* p) -> DWORD {
      static_cast<CaptureManager*>(p)->RenderThread();
      return 0;
    }, this, 0, nullptr);

  if (!m_renderThread) {
    Probe("start failed: render thread");
    m_running.store(false);
    CloseHandle(m_stopEvent);
    m_stopEvent = nullptr;
    Cleanup();
    return false;
  }
  Probe("start ok");
  return true;
}

void CaptureManager::Stop() {
  m_running.store(false);
  if (m_stopEvent) SetEvent(m_stopEvent);
  if (m_renderThread) {
    WaitForSingleObject(m_renderThread, INFINITE);
    CloseHandle(m_renderThread);
    m_renderThread = nullptr;
  }
  if (m_stopEvent) { CloseHandle(m_stopEvent); m_stopEvent = nullptr; }
  Cleanup();
}

void CaptureManager::Update(const RenderParams& params) {
  { std::lock_guard<std::mutex> lk(m_paramsMutex); m_params = params; }
  const int size = OutputSize(params);
  if (size != m_desiredOutputSize.exchange(size)) UpdateOverlayBounds(size);
  ++m_settingsVersion;
}

void CaptureManager::SetVisible(bool visible) {
  m_visible.store(visible);
  ++m_settingsVersion;
  if (m_overlayHwnd) ShowWindow(m_overlayHwnd, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
}

int CaptureManager::OutputSize(const RenderParams& params) const {
  const UINT dpi = m_overlayHwnd ? GetDpiForWindow(m_overlayHwnd) : GetDpiForSystem();
  return (std::max)(1, static_cast<int>(std::round(params.radius * 2 * params.scale * dpi / 96.0)));
}

void CaptureManager::UpdateOverlayBounds(int size) {
  if (!m_overlayHwnd) return;
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  POINT origin{0, 0};
  if (!GetMonitorInfoW(MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY), &mi)) return;
  const RECT& rect = mi.rcMonitor;
  SetWindowPos(m_overlayHwnd, HWND_TOPMOST,
    rect.left + (rect.right - rect.left - size) / 2,
    rect.top + (rect.bottom - rect.top - size) / 2,
    size, size, SWP_NOACTIVATE);
  HRGN rgn = CreateEllipticRgn(0, 0, size, size);
  if (rgn && !SetWindowRgn(m_overlayHwnd, rgn, TRUE)) DeleteObject(rgn);
}

/* ==================================================================
 *  Window
 * ================================================================*/

bool CaptureManager::CreateOverlayWindow() {
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = DefWindowProcW;
  wc.hInstance = m_hInstance;
  wc.lpszClassName = kWC;
  wc.style = CS_HREDRAW | CS_VREDRAW;
  RegisterClassExW(&wc);

  m_overlayHwnd = CreateWindowExW(
    WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
    kWC, L"Centre Magnifying", WS_POPUP,
    0, 0,
    m_outputSize, m_outputSize,
    nullptr, nullptr, m_hInstance, nullptr);
  if (!m_overlayHwnd) {
    Probe("overlay failed: CreateWindowExW");
    return false;
  }

  if (!SetLayeredWindowAttributes(m_overlayHwnd, 0, 255, LWA_ALPHA)) return false;
  UpdateOverlayBounds(m_outputSize);
  ShowWindow(m_overlayHwnd, SW_SHOWNOACTIVATE);
  UpdateWindow(m_overlayHwnd);
  Probe("overlay ok");
  return true;
}

/* ==================================================================
 *  D3D11
 * ================================================================*/

bool CaptureManager::InitD3D11() {
  D3D_FEATURE_LEVEL lvls[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
  UINT flg = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#ifdef _DEBUG
  flg |= D3D11_CREATE_DEVICE_DEBUG;
#endif

  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
    flg, lvls, _countof(lvls), D3D11_SDK_VERSION,
    m_device.put(), nullptr, m_context.put());
  if (FAILED(hr)) { ProbeHr("d3d device failed", hr); return false; }

  hr = m_context->QueryInterface(IID_PPV_ARGS(m_multithread.put()));
  if (FAILED(hr)) { ProbeHr("d3d multithread failed", hr); return false; }
  m_multithread->SetMultithreadProtected(TRUE);

  // SwapChain
  DXGI_SWAP_CHAIN_DESC scd{};
  scd.BufferCount = 1;
  scd.BufferDesc.Width = m_outputSize;
  scd.BufferDesc.Height = m_outputSize;
  scd.BufferDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  scd.OutputWindow = m_overlayHwnd;
  scd.SampleDesc.Count = 1;
  scd.Windowed = TRUE;
  scd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

  winrt::com_ptr<IDXGIDevice> dxgiDev;
  hr = m_device->QueryInterface(IID_PPV_ARGS(dxgiDev.put()));
  if (FAILED(hr)) { ProbeHr("dxgi device failed", hr); return false; }

  IDXGIAdapter* rawAdapter = nullptr;
  hr = dxgiDev->GetAdapter(&rawAdapter);
  if (FAILED(hr)) { ProbeHr("dxgi adapter failed", hr); return false; }
  winrt::com_ptr<IDXGIAdapter> adapter;
  adapter.attach(rawAdapter);

  IDXGIFactory2* rawFactory = nullptr;
  hr = adapter->GetParent(IID_PPV_ARGS(&rawFactory));
  if (FAILED(hr)) { ProbeHr("dxgi factory failed", hr); return false; }
  winrt::com_ptr<IDXGIFactory2> factory;
  factory.attach(rawFactory);

  hr = factory->CreateSwapChain(m_device.get(), &scd, m_swapChain.put());
  if (FAILED(hr)) { ProbeHr("swapchain failed", hr); return false; }

  factory->MakeWindowAssociation(m_overlayHwnd, DXGI_MWA_NO_ALT_ENTER);

  // Compile shaders
  winrt::com_ptr<ID3DBlob> vsb, psb, err;
  if (FAILED(D3DCompile(g_vsSrc, strlen(g_vsSrc), "vs", nullptr, nullptr,
        "main", "vs_4_0", 0, 0, vsb.put(), err.put())) ||
      FAILED(D3DCompile(g_psSrc, strlen(g_psSrc), "ps", nullptr, nullptr,
        "main", "ps_4_0", 0, 0, psb.put(), err.put()))) {
    Probe("shader compile failed");
    return false;
  }

  hr = m_device->CreateVertexShader(vsb->GetBufferPointer(),
    vsb->GetBufferSize(), nullptr, m_vs.put());
  if (FAILED(hr)) { ProbeHr("vertex shader failed", hr); return false; }
  hr = m_device->CreatePixelShader(psb->GetBufferPointer(),
    psb->GetBufferSize(), nullptr, m_ps.put());
  if (FAILED(hr)) { ProbeHr("pixel shader failed", hr); return false; }

  D3D11_INPUT_ELEMENT_DESC ied[] = {
    {"POSITION",0,DXGI_FORMAT_R32G32_FLOAT,0,0,D3D11_INPUT_PER_VERTEX_DATA,0},
    {"TEXCOORD",0,DXGI_FORMAT_R32G32_FLOAT,0,8,D3D11_INPUT_PER_VERTEX_DATA,0},
  };
  hr = m_device->CreateInputLayout(ied, 2, vsb->GetBufferPointer(),
    vsb->GetBufferSize(), m_inputLayout.put());
  if (FAILED(hr)) { ProbeHr("input layout failed", hr); return false; }

  D3D11_BUFFER_DESC bd{};
  bd.Usage = D3D11_USAGE_DEFAULT;
  bd.ByteWidth = sizeof(g_quad);
  bd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
  D3D11_SUBRESOURCE_DATA sd{ g_quad, 0, 0 };
  hr = m_device->CreateBuffer(&bd, &sd, m_vertexBuffer.put());
  if (FAILED(hr)) { ProbeHr("vertex buffer failed", hr); return false; }

  bd.ByteWidth = sizeof(CBData);
  bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  hr = m_device->CreateBuffer(&bd, nullptr, m_cbParams.put());
  if (FAILED(hr)) { ProbeHr("constant buffer failed", hr); return false; }

  D3D11_SAMPLER_DESC sdsc{};
  sdsc.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  sdsc.AddressU = sdsc.AddressV = sdsc.AddressW =
    D3D11_TEXTURE_ADDRESS_CLAMP;
  hr = m_device->CreateSamplerState(&sdsc, m_samplerLinear.put());
  if (FAILED(hr)) { ProbeHr("linear sampler failed", hr); return false; }
  sdsc.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
  hr = m_device->CreateSamplerState(&sdsc, m_samplerPoint.put());
  if (FAILED(hr)) { ProbeHr("point sampler failed", hr); return false; }

  Probe("d3d ok");
  return true;
}

/* ==================================================================
 *  WGC
 * ================================================================*/

bool CaptureManager::InitWgcCapture() {
  if (!wgcap::GraphicsCaptureSession::IsSupported()) {
    Probe("wgc unsupported");
    return false;
  }

  winrt::com_ptr<IDXGIDevice> dxgiDev;
  HRESULT hr = m_device->QueryInterface(IID_PPV_ARGS(dxgiDev.put()));
  if (FAILED(hr)) { ProbeHr("wgc dxgi device failed", hr); return false; }

  winrt::com_ptr<::IInspectable> d3dInsp;
  hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDev.get(), d3dInsp.put());
  if (FAILED(hr)) { ProbeHr("wgc d3d interop failed", hr); return false; }

  auto state = std::make_shared<FrameState>();
  state->device = m_device;
  state->context = m_context;
  state->winrtDevice = d3dInsp.as<wgd3d::IDirect3DDevice>();
  m_frameState = state;

  auto interop = winrt::get_activation_factory<
    wgcap::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  winrt::com_ptr<::IUnknown> itemUnk;
  hr = interop->CreateForWindow(m_targetHwnd,
    winrt::guid_of<wgcap::GraphicsCaptureItem>(), itemUnk.put_void());
  if (FAILED(hr) || !itemUnk) { ProbeHr("wgc CreateForWindow failed", hr); return false; }
  m_captureItem = itemUnk.as<wgcap::GraphicsCaptureItem>();
  state->poolSize = m_captureItem.Size();
  if (state->poolSize.Width <= 0 || state->poolSize.Height <= 0) return false;
  if (ProbeEnabled()) {
    std::fprintf(stderr, "[native-wgc-probe] capture-item size=%dx%d\n",
      state->poolSize.Width, state->poolSize.Height);
  }

  constexpr auto format = wgfx::DirectXPixelFormat::B8G8R8A8UIntNormalized;
  m_framePool = wgcap::Direct3D11CaptureFramePool::CreateFreeThreaded(
    state->winrtDevice, format, 2, state->poolSize);
  m_captureSession = m_framePool.CreateCaptureSession(m_captureItem);
  try { m_captureSession.IsCursorCaptureEnabled(false); }
  catch (const winrt::hresult_error&) { Probe("cursor capture setting unavailable"); }

  // The callback owns its state, so an already-dispatched callback cannot access
  // the CaptureManager after Stop has revoked and closed the frame pool.
  m_frameArrivedToken = m_framePool.FrameArrived(
    [state](wgcap::Direct3D11CaptureFramePool const& sender, wf::IInspectable const&) {
      std::lock_guard<std::mutex> lock(state->mutex);
      if (!state->active) return;
      try {
        auto frame = sender.TryGetNextFrame();
        if (!frame) return;
        const auto size = frame.ContentSize();
        if (size.Width <= 0 || size.Height <= 0) return;
        if (size.Width != state->poolSize.Width || size.Height != state->poolSize.Height) {
          frame.Close();
          state->latestFrameSRV = nullptr;
          state->latestFrame = nullptr;
          sender.Recreate(state->winrtDevice, format, 2, size);
          state->poolSize = size;
          Probe("frame pool resized");
          return;
        }

        auto surface = frame.Surface();
        if (!surface) return;
        auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        winrt::com_ptr<ID3D11Texture2D> frameTex;
        HRESULT result = access->GetInterface(__uuidof(ID3D11Texture2D), frameTex.put_void());
        if (FAILED(result)) { ProbeHr("frame texture failed", result); return; }

        D3D11_TEXTURE2D_DESC desc{};
        frameTex->GetDesc(&desc);
        if (!state->latestFrame) {
          D3D11_TEXTURE2D_DESC copyDesc{};
          copyDesc.Width = desc.Width;
          copyDesc.Height = desc.Height;
          copyDesc.MipLevels = 1;
          copyDesc.ArraySize = 1;
          copyDesc.Format = desc.Format;
          copyDesc.SampleDesc.Count = 1;
          copyDesc.Usage = D3D11_USAGE_DEFAULT;
          copyDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
          result = state->device->CreateTexture2D(&copyDesc, nullptr, state->latestFrame.put());
          if (FAILED(result)) { ProbeHr("frame copy texture failed", result); return; }
          result = state->device->CreateShaderResourceView(
            state->latestFrame.get(), nullptr, state->latestFrameSRV.put());
          if (FAILED(result)) {
            state->latestFrame = nullptr;
            ProbeHr("frame shader resource failed", result);
            return;
          }
        }

        state->context->CopyResource(state->latestFrame.get(), frameTex.get());
        ProbeFrame(++state->frameCount, desc.Width, desc.Height, desc.Format);
      } catch (const winrt::hresult_error& error) {
        ProbeHr("frame callback failed", error.code());
      } catch (...) {
        Probe("frame callback failed: unexpected exception");
      }
    });

  m_captureSession.StartCapture();
  Probe("wgc started");
  return true;
}
/* ==================================================================
 *  Render loop
 * ================================================================*/

void CaptureManager::RenderThread() {
  auto nextFrame = std::chrono::steady_clock::now();
  while (m_running.load()) {
    int fps;
    { std::lock_guard<std::mutex> lk(m_paramsMutex); fps = (std::max)(1, m_params.fps); }
    const auto interval = std::chrono::nanoseconds(1000000000LL / fps);
    nextFrame += interval;
    const auto now = std::chrono::steady_clock::now();
    if (now > nextFrame + interval) nextFrame = now;
    const auto delay = std::chrono::duration_cast<std::chrono::milliseconds>(
      nextFrame - now + std::chrono::microseconds(999)).count();
    if (WaitForSingleObject(m_stopEvent, static_cast<DWORD>((std::max)(0LL, delay))) == WAIT_OBJECT_0) break;
    if (!IsWindow(m_targetHwnd)) {
      Probe("target window closed");
      m_running.store(false);
      if (m_overlayHwnd) ShowWindowAsync(m_overlayHwnd, SW_HIDE);
      break;
    }
    if (m_visible.load()) RenderFrame();
  }
}

void CaptureManager::RenderFrame() {
  RenderParams p;
  { std::lock_guard<std::mutex> lk(m_paramsMutex); p = m_params; }
  const auto settingsVersion = m_settingsVersion.load();
  const auto state = m_frameState;
  if (!state) return;
  // Keep the copy and the entire draw mutually exclusive on the immediate context.
  std::lock_guard<std::mutex> frameLock(state->mutex);
  if (!state->active || !state->latestFrame || !state->latestFrameSRV) return;
  if (state->frameCount == m_lastRenderedFrame && settingsVersion == m_lastRenderedSettings) return;

  const int out = m_desiredOutputSize.load();
  if (out != m_outputSize) {
    m_backBufferRTV = nullptr;
    m_context->OMSetRenderTargets(0, nullptr, nullptr);
    HRESULT resizeHr = m_swapChain->ResizeBuffers(1, out, out, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
    if (FAILED(resizeHr)) {
      ProbeHr("resize failed", resizeHr);
      return;
    }
    m_outputSize = out;
  }

  if (!m_backBufferRTV) {
    winrt::com_ptr<ID3D11Texture2D> bb;
    HRESULT bufferHr = m_swapChain->GetBuffer(0, IID_PPV_ARGS(bb.put()));
    if (FAILED(bufferHr)) { ProbeHr("backbuffer failed", bufferHr); return; }
    HRESULT rtvHr = m_device->CreateRenderTargetView(bb.get(), nullptr, m_backBufferRTV.put());
    if (FAILED(rtvHr)) { ProbeHr("rtv failed", rtvHr); return; }
  }

  float clr[4]{0.0f, 0.0f, 0.0f, 1.0f};
  m_context->ClearRenderTargetView(m_backBufferRTV.get(), clr);
  ID3D11RenderTargetView* rtv = m_backBufferRTV.get();
  m_context->OMSetRenderTargets(1, &rtv, nullptr);

  D3D11_VIEWPORT vp{0,0,(float)m_outputSize,(float)m_outputSize,0,1};
  m_context->RSSetViewports(1, &vp);

  auto srv = state->latestFrameSRV;
  D3D11_TEXTURE2D_DESC d{};
  state->latestFrame->GetDesc(&d);
  const int vw = static_cast<int>(d.Width);
  const int vh = static_cast<int>(d.Height);
  if (vw <= 0 || vh <= 0) return;

  int ss = p.radius * 2;
  int sf = (std::min)((std::min)(ss, vw), vh);
  int sx = static_cast<int>(std::round((vw - sf) / 2.0));
  int sy = static_cast<int>(std::round((vh - sf) / 2.0));
  CBData cb{ (float)sf/vw, (float)sf/vh, (float)sx/vw, (float)sy/vh };

  m_context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  m_context->IASetInputLayout(m_inputLayout.get());
  UINT str = sizeof(Vertex), off = 0;
  ID3D11Buffer* vertexBuffer = m_vertexBuffer.get();
  m_context->IASetVertexBuffers(0, 1, &vertexBuffer, &str, &off);
  m_context->VSSetShader(m_vs.get(), nullptr, 0);
  m_context->PSSetShader(m_ps.get(), nullptr, 0);
  ID3D11ShaderResourceView* shaderResource = srv.get();
  m_context->PSSetShaderResources(0, 1, &shaderResource);
  ID3D11SamplerState* sampler =
    p.smoothing ? m_samplerLinear.get() : m_samplerPoint.get();
  m_context->PSSetSamplers(0, 1, &sampler);
  m_context->UpdateSubresource(m_cbParams.get(), 0, nullptr, &cb, 0, 0);
  ID3D11Buffer* constantBuffer = m_cbParams.get();
  m_context->VSSetConstantBuffers(0, 1, &constantBuffer);
  m_context->PSSetConstantBuffers(0, 1, &constantBuffer);
  m_context->Draw(6, 0);
  ID3D11ShaderResourceView* nullSrv = nullptr;
  m_context->PSSetShaderResources(0, 1, &nullSrv);

  HRESULT presentHr = m_swapChain->Present(0, 0);
  if (FAILED(presentHr)) { ProbeHr("present failed", presentHr); return; }
  m_lastRenderedFrame = state->frameCount;
  m_lastRenderedSettings = settingsVersion;
  unsigned long long renderCount = ++m_renderCount;
  ProbeRender(renderCount, vw, vh, sx, sy, sf, presentHr);
}

/* ==================================================================
 *  Cleanup
 * ================================================================*/

void CaptureManager::Cleanup() {
  if (m_frameState) {
    std::lock_guard<std::mutex> lk(m_frameState->mutex);
    m_frameState->active = false;
  }
  try {
    if (m_framePool && m_frameArrivedToken.value) m_framePool.FrameArrived(m_frameArrivedToken);
    if (m_captureSession) m_captureSession.Close();
    if (m_framePool) m_framePool.Close();
  } catch (const winrt::hresult_error& error) {
    ProbeHr("capture cleanup failed", error.code());
  }
  m_frameArrivedToken.value = 0;
  m_captureSession = nullptr;
  m_framePool = nullptr;
  m_captureItem = nullptr;
  m_frameState.reset();

  // D3D11 resources
  m_backBufferRTV = nullptr;
  m_cbParams = nullptr;
  m_samplerLinear = nullptr; m_samplerPoint = nullptr;
  m_vertexBuffer = nullptr;
  m_inputLayout = nullptr;
  m_ps = nullptr; m_vs = nullptr;
  m_swapChain = nullptr;
  m_multithread = nullptr;
  m_context = nullptr; m_device = nullptr;

  // Window
  if (m_overlayHwnd) {
    DestroyWindow(m_overlayHwnd);
    m_overlayHwnd = nullptr;
  }
  if (m_hInstance) UnregisterClassW(kWC, m_hInstance);
}

} // namespace wgc

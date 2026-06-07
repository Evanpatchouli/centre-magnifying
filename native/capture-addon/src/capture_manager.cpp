#include "capture_manager.h"

#include <dispatcherqueue.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>

#include <cstdio>
#include <cstdlib>

// Manual fallback definition in case the SDK interop header doesn't provide it.
#ifndef __IDirect3DDxgiInterfaceAccess_INTERFACE_DEFINED__
struct __declspec(uuid("A9B3D012-3DF2-4EE3-B8D1-86A42A4A5A6D"))
IDirect3DDxgiInterfaceAccess : public IUnknown
{
  virtual HRESULT STDMETHODCALLTYPE GetInterface(REFIID iid, void** ppv) = 0;
};
#endif

#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

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
  {-1,-1,0,0}, {1,-1,1,0}, {-1,1,0,1},
  { 1,-1,1,0}, {-1,1,0,1}, { 1,1,1,1},
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

void ProbeStart(HWND hwnd, RECT target, RECT monitor, int outputSize) {
  if (!ProbeEnabled()) return;
  std::fprintf(
    stderr,
    "[native-wgc-probe] start hwnd=%p target=(%ld,%ld,%ld,%ld) monitor=(%ld,%ld,%ld,%ld) outputSize=%d\n",
    hwnd,
    target.left, target.top, target.right, target.bottom,
    monitor.left, monitor.top, monitor.right, monitor.bottom,
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
  std::lock_guard<std::mutex> lk(m_paramsMutex);
  m_params = params;
  m_frameCount.store(0);
  m_renderCount.store(0);

  m_targetHwnd = targetHwnd;
  if (!GetWindowRect(targetHwnd, &m_targetRect)) {
    Probe("start failed: GetWindowRect");
    return false;
  }
  m_captureMonitor = MonitorFromWindow(targetHwnd, MONITOR_DEFAULTTONEAREST);
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  if (!m_captureMonitor || !GetMonitorInfoW(m_captureMonitor, &mi)) {
    Probe("start failed: monitor info");
    return false;
  }
  m_monitorRect = mi.rcMonitor;
  m_hInstance = GetModuleHandleW(nullptr);

  m_outputSize = static_cast<int>(
      std::round(params.radius * 2 * params.scale));
  ProbeStart(targetHwnd, m_targetRect, m_monitorRect, m_outputSize);

  if (!CreateOverlayWindow()) { Cleanup(); return false; }
  if (!InitD3D11())           { Cleanup(); return false; }
  if (!InitWgcCapture())      { Cleanup(); return false; }

  m_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  m_running.store(true);
  m_renderThread = CreateThread(nullptr, 0,
    [](void* p) -> DWORD {
      static_cast<CaptureManager*>(p)->RenderThread();
      return 0;
    }, this, 0, nullptr);

  if (!m_renderThread) {
    Probe("start failed: render thread");
    return false;
  }
  Probe("start ok");
  return true;
}

void CaptureManager::Stop() {
  if (!m_running.load()) return;
  m_running.store(false);
  if (m_stopEvent) SetEvent(m_stopEvent);
  if (m_renderThread) {
    WaitForSingleObject(m_renderThread, 5000);
    CloseHandle(m_renderThread);
    m_renderThread = nullptr;
  }
  if (m_stopEvent) { CloseHandle(m_stopEvent); m_stopEvent = nullptr; }
  Cleanup();
}

void CaptureManager::Update(const RenderParams& params) {
  std::lock_guard<std::mutex> lk(m_paramsMutex);
  m_params = params;
  int ns = static_cast<int>(std::round(params.radius * 2 * params.scale));
  if (ns != m_outputSize && m_overlayHwnd) {
    m_outputSize = ns;
    SetWindowPos(m_overlayHwnd, nullptr, 0, 0, ns, ns,
                 SWP_NOZORDER | SWP_NOMOVE | SWP_NOACTIVATE);
    HRGN rgn = CreateEllipticRgn(0, 0, ns, ns);
    SetWindowRgn(m_overlayHwnd, rgn, TRUE);
    DeleteObject(rgn);
  }
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

  int mw = m_monitorRect.right - m_monitorRect.left;
  int mh = m_monitorRect.bottom - m_monitorRect.top;
  m_overlayHwnd = CreateWindowExW(
    WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
    kWC, L"Centre Magnifying", WS_POPUP,
    m_monitorRect.left + (mw - m_outputSize) / 2,
    m_monitorRect.top + (mh - m_outputSize) / 2,
    m_outputSize, m_outputSize,
    nullptr, nullptr, m_hInstance, nullptr);
  if (!m_overlayHwnd) {
    Probe("overlay failed: CreateWindowExW");
    return false;
  }

  if (!SetWindowDisplayAffinity(m_overlayHwnd, WDA_EXCLUDEFROMCAPTURE)) {
    Probe("overlay warning: SetWindowDisplayAffinity failed");
  }

  HRGN rgn = CreateEllipticRgn(0, 0, m_outputSize, m_outputSize);
  SetWindowRgn(m_overlayHwnd, rgn, TRUE);
  DeleteObject(rgn);
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

  if (SUCCEEDED(m_device->QueryInterface(IID_PPV_ARGS(m_multithread.put())))) {
    m_multithread->SetMultithreadProtected(TRUE);
  }

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

  m_device->CreateVertexShader(vsb->GetBufferPointer(),
    vsb->GetBufferSize(), nullptr, m_vs.put());
  m_device->CreatePixelShader(psb->GetBufferPointer(),
    psb->GetBufferSize(), nullptr, m_ps.put());

  D3D11_INPUT_ELEMENT_DESC ied[] = {
    {"POSITION",0,DXGI_FORMAT_R32G32_FLOAT,0,0,D3D11_INPUT_PER_VERTEX_DATA,0},
    {"TEXCOORD",0,DXGI_FORMAT_R32G32_FLOAT,0,8,D3D11_INPUT_PER_VERTEX_DATA,0},
  };
  m_device->CreateInputLayout(ied, 2, vsb->GetBufferPointer(),
    vsb->GetBufferSize(), m_inputLayout.put());

  D3D11_BUFFER_DESC bd{};
  bd.Usage = D3D11_USAGE_DEFAULT;
  bd.ByteWidth = sizeof(g_quad);
  bd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
  D3D11_SUBRESOURCE_DATA sd{ g_quad, 0, 0 };
  m_device->CreateBuffer(&bd, &sd, m_vertexBuffer.put());

  bd.ByteWidth = sizeof(CBData);
  bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  m_device->CreateBuffer(&bd, nullptr, m_cbParams.put());

  D3D11_SAMPLER_DESC sdsc{};
  sdsc.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  sdsc.AddressU = sdsc.AddressV = sdsc.AddressW =
    D3D11_TEXTURE_ADDRESS_CLAMP;
  m_device->CreateSamplerState(&sdsc, m_samplerLinear.put());
  sdsc.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
  m_device->CreateSamplerState(&sdsc, m_samplerPoint.put());

  Probe("d3d ok");
  return true;
}

/* ==================================================================
 *  WGC
 * ================================================================*/

bool CaptureManager::InitWgcCapture() {
  // Ensure DispatcherQueue on this thread
  DispatcherQueueOptions dqo{
    sizeof(DispatcherQueueOptions), DQTYPE_THREAD_CURRENT, DQTAT_COM_NONE
  };
  ABI::Windows::System::IDispatcherQueueController* rawCtrl = nullptr;
  HRESULT hr = CreateDispatcherQueueController(dqo, &rawCtrl);
  // S_OK = created, 0x80071397 = already exists – both are fine
  if (FAILED(hr) && hr != 0x80071397L) {
    ProbeHr("dispatcher queue failed", hr);
    return false;
  }

  // Get WinRT IDirect3DDevice from D3D11 device
  winrt::com_ptr<IDXGIDevice> dxgiDev;
  hr = m_device->QueryInterface(IID_PPV_ARGS(dxgiDev.put()));
  if (FAILED(hr)) { ProbeHr("wgc dxgi device failed", hr); return false; }

  winrt::com_ptr<::IInspectable> d3dInsp;
  hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDev.get(), d3dInsp.put());
  if (FAILED(hr)) { ProbeHr("wgc d3d interop failed", hr); return false; }

  wgd3d::IDirect3DDevice d3dDev{nullptr};
  try { d3dDev = d3dInsp.as<wgd3d::IDirect3DDevice>(); }
  catch (...) { Probe("wgc d3d device cast failed"); return false; }

  // Capture the monitor that contains the target window. Some accelerated game
  // windows can produce white frames with CreateForWindow while monitor capture
  // remains visible; RenderFrame crops back to the target window centre.
  auto interop = winrt::get_activation_factory<
    wgcap::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();

  winrt::com_ptr<::IUnknown> itemUnk;
  hr = interop->CreateForMonitor(m_captureMonitor,
    winrt::guid_of<wgcap::GraphicsCaptureItem>(), itemUnk.put_void());
  if (FAILED(hr) || !itemUnk) { ProbeHr("wgc CreateForMonitor failed", hr); return false; }

  try { m_captureItem = itemUnk.as<wgcap::GraphicsCaptureItem>(); }
  catch (...) { Probe("wgc capture item cast failed"); return false; }

  auto sz = m_captureItem.Size();
  if (ProbeEnabled()) {
    std::fprintf(stderr, "[native-wgc-probe] capture-item size=%dx%d\n", sz.Width, sz.Height);
  }

  // Frame pool
  m_framePool = wgcap::Direct3D11CaptureFramePool::CreateFreeThreaded(
    d3dDev, wgfx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, sz);

  // Session
  m_captureSession = m_framePool.CreateCaptureSession(m_captureItem);
  m_captureSession.IsCursorCaptureEnabled(false);

  // Frame arrived handler
  // Don't use auto_revoke – store event_token for manual revocation in Cleanup.
  m_frameArrivedToken = m_framePool.FrameArrived(
    [this](wgcap::Direct3D11CaptureFramePool const&, wf::IInspectable const&) {
      auto frame = m_framePool.TryGetNextFrame();
      if (!frame) return;

      auto surface = frame.Surface();
      if (!surface) return;

      winrt::com_ptr<IDXGISurface> dxgiSurf;
      try {
        auto access = surface.as<IDirect3DDxgiInterfaceAccess>();
        access->GetInterface(winrt::guid_of<IDXGISurface>(),
                            dxgiSurf.put_void());
      } catch (...) { return; }
      if (!dxgiSurf) return;

      ID3D11Texture2D* rawTex = nullptr;
      HRESULT qiHr = dxgiSurf->QueryInterface(
        __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&rawTex));
      if (FAILED(qiHr) || !rawTex) return;
      winrt::com_ptr<ID3D11Texture2D> frameTex;
      frameTex.attach(rawTex);

      D3D11_TEXTURE2D_DESC desc;
      frameTex->GetDesc(&desc);
      unsigned long long frameCount = ++m_frameCount;
      ProbeFrame(frameCount, desc.Width, desc.Height, desc.Format);

      std::lock_guard<std::mutex> lk(m_frameMutex);

      if (m_latestFrame) {
        D3D11_TEXTURE2D_DESC cur;
        m_latestFrame->GetDesc(&cur);
        if (cur.Width != desc.Width || cur.Height != desc.Height) {
          m_latestFrameSRV = nullptr; m_latestFrame = nullptr;
        }
      }

      if (!m_latestFrame) {
        D3D11_TEXTURE2D_DESC td{};
        td.Width = desc.Width; td.Height = desc.Height;
        td.MipLevels = 1; td.ArraySize = 1; td.Format = desc.Format;
        td.SampleDesc.Count = 1; td.Usage = D3D11_USAGE_DEFAULT;
        td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        m_device->CreateTexture2D(&td, nullptr, m_latestFrame.put());
        m_device->CreateShaderResourceView(
          m_latestFrame.get(), nullptr, m_latestFrameSRV.put());
      }

      m_context->CopyResource(m_latestFrame.get(), frameTex.get());
    });

  m_captureSession.StartCapture();
  Probe("wgc started");
  return true;
}

/* ==================================================================
 *  Render loop
 * ================================================================*/

void CaptureManager::RenderThread() {
  while (m_running.load()) {
    if (WaitForSingleObject(m_stopEvent, 8) == WAIT_OBJECT_0) break;
    RenderFrame();
  }
}

void CaptureManager::RenderFrame() {
  RenderParams p;
  { std::lock_guard<std::mutex> lk(m_paramsMutex); p = m_params; }

  int out = static_cast<int>(std::round(p.radius * 2 * p.scale));
  if (out != m_outputSize) {
    m_outputSize = out;
    m_backBufferRTV = nullptr;
    m_context->OMSetRenderTargets(0, nullptr, nullptr);
    HRESULT resizeHr = m_swapChain->ResizeBuffers(1, out, out, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
    if (FAILED(resizeHr)) {
      ProbeHr("resize failed", resizeHr);
      return;
    }
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

  winrt::com_ptr<ID3D11ShaderResourceView> srv;
  int vw = 0, vh = 0;
  {
    std::lock_guard<std::mutex> lk(m_frameMutex);
    if (!m_latestFrame) { m_swapChain->Present(0, 0); return; }
    srv = m_latestFrameSRV;
    D3D11_TEXTURE2D_DESC d;
    m_latestFrame->GetDesc(&d);
    vw = (int)d.Width; vh = (int)d.Height;
  }
  if (!srv || vw <= 0) { m_swapChain->Present(0, 0); return; }

  int ss = p.radius * 2;
  int sf = (std::min)((std::min)(ss, vw), vh);
  RECT targetRect = m_targetRect;
  if (m_targetHwnd) {
    RECT liveRect{};
    if (GetWindowRect(m_targetHwnd, &liveRect)) {
      targetRect = liveRect;
      m_targetRect = liveRect;
    }
  }

  int monitorW = (std::max)(1L, m_monitorRect.right - m_monitorRect.left);
  int monitorH = (std::max)(1L, m_monitorRect.bottom - m_monitorRect.top);
  double scaleX = static_cast<double>(vw) / static_cast<double>(monitorW);
  double scaleY = static_cast<double>(vh) / static_cast<double>(monitorH);
  double centerX = (static_cast<double>(targetRect.left + targetRect.right) / 2.0 -
                    static_cast<double>(m_monitorRect.left)) * scaleX;
  double centerY = (static_cast<double>(targetRect.top + targetRect.bottom) / 2.0 -
                    static_cast<double>(m_monitorRect.top)) * scaleY;

  int sx = static_cast<int>(std::round(centerX - sf / 2.0));
  int sy = static_cast<int>(std::round(centerY - sf / 2.0));
  sx = (std::max)(0, (std::min)(sx, vw - sf));
  sy = (std::max)(0, (std::min)(sy, vh - sf));
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
  unsigned long long renderCount = ++m_renderCount;
  ProbeRender(renderCount, vw, vh, sx, sy, sf, presentHr);
}

/* ==================================================================
 *  Cleanup
 * ================================================================*/

void CaptureManager::Cleanup() {
  // Revoke frame handler, then release WGC objects
  if (m_framePool && m_frameArrivedToken.value) {
    m_framePool.FrameArrived(m_frameArrivedToken);
    m_frameArrivedToken.value = 0;
  }
  m_captureSession = nullptr;
  m_framePool = nullptr;
  m_captureItem = nullptr;

  // Frame copy
  {
    std::lock_guard<std::mutex> lk(m_frameMutex);
    m_latestFrameSRV = nullptr;
    m_latestFrame = nullptr;
  }

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

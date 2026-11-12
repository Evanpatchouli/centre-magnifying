#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <d3d11.h>
#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>

// C++/WinRT for Windows.Graphics.Capture
#include <winrt/base.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>

#include <atomic>
#include <memory>
#include <mutex>

namespace wgc {

namespace wf    = winrt::Windows::Foundation;
namespace wgcap = winrt::Windows::Graphics::Capture;
namespace wgfx  = winrt::Windows::Graphics::DirectX;
namespace wgd3d = winrt::Windows::Graphics::DirectX::Direct3D11;

struct RenderParams {
  int radius = 120;
  double scale = 2.0;
  int fps = 60;
  bool smoothing = true;
};

struct FrameState {
  std::mutex mutex;
  bool active = true;
  unsigned long long frameCount = 0;
  winrt::Windows::Graphics::SizeInt32 poolSize{};
  wgd3d::IDirect3DDevice winrtDevice{nullptr};
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext> context;
  winrt::com_ptr<ID3D11Texture2D> latestFrame;
  winrt::com_ptr<ID3D11ShaderResourceView> latestFrameSRV;
};

/**
 * Manages full native capture + render pipeline:
 *   WGC capture -> D3D11 texture -> pixel shader -> swapchain -> overlay window
 *
 * Runs a dedicated thread for the rendering loop.
 */
class CaptureManager {
public:
  CaptureManager() = default;
  ~CaptureManager();

  CaptureManager(const CaptureManager&) = delete;
  CaptureManager& operator=(const CaptureManager&) = delete;

  bool Start(HWND targetHwnd, const RenderParams& params);
  void Update(const RenderParams& params);
  void Stop();
  void SetVisible(bool visible);
  bool IsVisible() const { return m_visible.load(); }
  bool IsRunning() const { return m_running.load(); }

private:
  bool InitD3D11();
  bool InitWgcCapture();
  bool CreateOverlayWindow();
  void RenderThread();
  void RenderFrame();
  void Cleanup();
  int OutputSize(const RenderParams& params) const;
  void UpdateOverlayBounds(int size);

  /* ── state ──────────────────────────────────────────────────── */
  std::atomic<bool> m_running{false};
  std::atomic<bool> m_visible{true};
  std::atomic<unsigned long long> m_renderCount{0};
  std::atomic<unsigned long long> m_settingsVersion{0};
  std::atomic<int> m_desiredOutputSize{0};
  unsigned long long m_lastRenderedFrame = 0;
  unsigned long long m_lastRenderedSettings = 0;
  std::mutex m_paramsMutex;
  RenderParams m_params;

  /* ── target / overlay ───────────────────────────────────────── */
  HWND m_targetHwnd = nullptr;
  HWND m_overlayHwnd = nullptr;
  HINSTANCE m_hInstance = nullptr;
  int m_outputSize = 0;

  /* ── D3D11 ──────────────────────────────────────────────────── */
  winrt::com_ptr<ID3D11Device> m_device;
  winrt::com_ptr<ID3D11DeviceContext> m_context;
  winrt::com_ptr<ID3D11Multithread> m_multithread;
  winrt::com_ptr<IDXGISwapChain> m_swapChain;
  winrt::com_ptr<ID3D11VertexShader> m_vs;
  winrt::com_ptr<ID3D11PixelShader> m_ps;
  winrt::com_ptr<ID3D11InputLayout> m_inputLayout;
  winrt::com_ptr<ID3D11Buffer> m_vertexBuffer;
  winrt::com_ptr<ID3D11Buffer> m_cbParams;
  winrt::com_ptr<ID3D11SamplerState> m_samplerLinear;
  winrt::com_ptr<ID3D11SamplerState> m_samplerPoint;

  /* ── WGC ────────────────────────────────────────────────────── */
  wgcap::GraphicsCaptureItem m_captureItem{nullptr};
  wgcap::Direct3D11CaptureFramePool m_framePool{nullptr};
  wgcap::GraphicsCaptureSession m_captureSession{nullptr};
  winrt::event_token m_frameArrivedToken{};

  /* ── shared frame ───────────────────────────────────────────── */
  std::shared_ptr<FrameState> m_frameState;
  winrt::com_ptr<ID3D11RenderTargetView> m_backBufferRTV;

  /* ── thread ─────────────────────────────────────────────────── */
  HANDLE m_renderThread = nullptr;
  HANDLE m_stopEvent = nullptr;
};

} // namespace wgc

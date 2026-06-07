#include <napi.h>
#include "capture_manager.h"

#include <string>
#include <memory>
#include <cstdlib>

namespace {

static std::unique_ptr<wgc::CaptureManager> g_manager;

/* ── helper: parse RenderParams from JS object ──────────────── */

wgc::RenderParams ParseParams(const Napi::Object& obj) {
  wgc::RenderParams p;
  if (obj.Has("radius"))    p.radius    = obj.Get("radius").As<Napi::Number>().Int32Value();
  if (obj.Has("scale"))     p.scale     = obj.Get("scale").As<Napi::Number>().DoubleValue();
  if (obj.Has("smoothing")) p.smoothing = obj.Get("smoothing").As<Napi::Boolean>().Value();
  return p;
}

/* ── start(hwnd: number, params: object) ─────────────────────── */

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "Expected (hwnd: number, params: object)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  int64_t hwndNum = info[0].As<Napi::Number>().Int64Value();
  HWND targetHwnd = reinterpret_cast<HWND>(static_cast<INT_PTR>(hwndNum));
  auto params = ParseParams(info[1].As<Napi::Object>());

  if (g_manager) {
    g_manager->Stop();
    g_manager.reset();
  }

  g_manager = std::make_unique<wgc::CaptureManager>();
  bool ok = g_manager->Start(targetHwnd, params);
  return Napi::Boolean::New(env, ok);
}

/* ── update(params: object) ──────────────────────────────────── */

Napi::Value Update(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!g_manager || !g_manager->IsRunning()) {
    return Napi::Boolean::New(env, false);
  }

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Expected (params: object)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto params = ParseParams(info[0].As<Napi::Object>());
  g_manager->Update(params);
  return Napi::Boolean::New(env, true);
}

/* ── stop() ──────────────────────────────────────────────────── */

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_manager) {
    g_manager->Stop();
    g_manager.reset();
    return Napi::Boolean::New(env, true);
  }
  return Napi::Boolean::New(env, false);
}

/* ── isRunning() ─────────────────────────────────────────────── */

Napi::Value IsRunning(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool running = g_manager && g_manager->IsRunning();
  return Napi::Boolean::New(env, running);
}

} // anonymous namespace

/* ── Module init ──────────────────────────────────────────────── */

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("start",     Napi::Function::New(env, Start));
  exports.Set("update",    Napi::Function::New(env, Update));
  exports.Set("stop",      Napi::Function::New(env, Stop));
  exports.Set("isRunning", Napi::Function::New(env, IsRunning));
  return exports;
}

NODE_API_MODULE(native_capture, InitModule)

{
  "targets": [
    {
      "target_name": "native_capture",
      "sources": [
        "src/addon.cpp",
        "src/capture_manager.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [
            "/await",
            "/EHsc",
            "/utf-8"
          ]
        }
      },
      "libraries": [
        "d3d11.lib",
        "dxgi.lib",
        "d3dcompiler.lib",
        "runtimeobject.lib",
        "windowsapp.lib"
      ],
      "conditions": [
        ["OS=='win'", {
          "defines": ["_WINDOWS"]
        }]
      ]
    }
  ]
}

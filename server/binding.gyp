{
  "targets": [{
    "target_name": "rfcaddon",
    "sources": ["src/rfc/rfcaddon.cc"],
    "include_dirs": [
      "nwrfcsdk/include",
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "libraries": [
      "-lsapnwrfc",
      "-lsapucum",
      "-L<(module_root_dir)/nwrfcsdk/lib"
    ],
    "ldflags": ["-Wl,-rpath,'$$ORIGIN/../../nwrfcsdk/lib'"],
    "cflags_cc": ["-fexceptions", "-std=c++17"],
    "defines": ["NAPI_CPP_EXCEPTIONS", "SAPwithUNICODE=1"]
  }]
}

// 场景收尾：把 `run` 命令接上 `window.__smoke_run`（运行器由 room-page.mjs 定义）。
//
// 本文件是**页内脚本的原文**：由 smoke/room-page.mjs 原样拼进页内 IIFE（在运行器之后），
// 不要把它塞回模板字符串（转义坑见 docs/testing.md §9.3）。
  document.addEventListener("__smoke-cmd", function (e) {
    if ((e.detail || {}).type === "run") window.__smoke_run();
  });

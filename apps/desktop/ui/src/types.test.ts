/// <reference types="node" />
// `types.ts` 里那几个**纯判定**的单测。跑法：
//
//     cd apps/desktop/ui && node --test src/types.test.ts
//
// 为什么单独钉这一条：开播返回是「推流端点 与 身份校验引导 **二选一**」的 `untagged`
// 载荷（`contract.md` §7），区分点只有一个——顶层 `code` 字段在不在。判错了就是
// 「把引导当推流参数渲染」（推流码是账号级凭据，错渲染等于拿引导内容当凭据），
// 或者反过来「开播被挡住了却什么都不弹」。这条判据在界面上是看不出对错的。
import assert from "node:assert/strict";
import { test } from "node:test";

import { isAnchorGate } from "./types.ts";
import type { AnchorGate, StreamEndpoints } from "./types.ts";

const GATE: AnchorGate = {
  code: 60043,
  message: "本次开播需要身份验证",
  kind: "faceauth",
  url: "https://example.invalid/auth",
  qr: "",
};

const ENDPOINTS: StreamEndpoints = {
  rtmp: { addr: "rtmp://a", code: "secret" },
  rtmp_backup: null,
  srt: null,
};

test("开播返回：有顶层 code 的判成引导", () => {
  assert.equal(isAnchorGate(GATE), true);
  assert.equal(isAnchorGate(null), false);
  assert.equal(isAnchorGate(undefined), false);
});

test("开播返回：推流端点没有顶层 code，不判成引导", () => {
  // `StreamEndpoints` 的 `code` 在 **rtmp 里面**，顶层没有 —— 它不能被当成引导。
  assert.equal(isAnchorGate(ENDPOINTS), false);
  assert.equal(isAnchorGate({ rtmp: null, rtmp_backup: null, srt: null }), false);
});

test("开播返回：60024 那条同样走引导分支", () => {
  assert.equal(isAnchorGate({ ...GATE, code: 60024, kind: "qrconfirm", qr: "qr-content" }), true);
});

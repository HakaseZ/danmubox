//! 按 uid 取用户资料 —— 当前只取头像（`docs/contract.md` §3 的 `UserProfile`）。
//!
//! 大航海、V1 礼物与缺头像的醒目留言的载荷里**没有头像字段**（`docs/protocol.md` §10.6 /
//! §10.2 / 附录 A8 / A12 / A13），而界面要求大航海必须有头像
//! （`REQUIREMENTS.md` §三 3.1–3.6、§八 第 1 条），因此只能按 `Message.uid` 现取。
//!
//! | 项 | 值 |
//! |---|---|
//! | 端点 | `GET https://api.bilibili.com/x/space/wbi/acc/info`（**WBI 签名**变体） |
//! | 请求 | `mid` + `wts` + `w_rid`（社区文档 `bilibili-API-collect` 的 `docs/user/info.md` 把这三个列为必要；`platform` / `web_location` / `token` 列为可选，**本实现不送**） |
//! | 头像 | 响应 `data.face`（字符串 URL） |
//! | 非 0 code | 一律按「取不到」处理（需求 3.3），**不写缓存**（需求 3.4） |
//!
//! **校准状态**：端点、参数与字段路径按社区文档核对，**本仓未实测**（结论登记在
//! `docs/protocol.md` 附录 A 的「按 uid 取头像」条目；核对入口 = `danmubox-cli face <uid>`）。
//!
//! 三条实现纪律：
//!
//! 1. **取不到即空串**（需求 3.3）：非 0 code、传输 / 解码失败、`uid <= 0` 都返回空串，
//!    不报错、不阻塞上屏 —— 端口因此没有错误通道（见 [`UserProfile`] 的说明）。
//! 2. **同一 uid 只问一次上游**（需求 3.4）：进程级缓存 + per-uid 在途锁（`FACE_LOCKS`，
//!    与 `http.rs` 的 `WBI_KEY_CACHE` 同一「单飞」意图，但不把全局缓存锁跨网络请求持有）。
//! 3. **失败不缓存**：非 0 code / 传输失败都不写槽位，下一条消息还能再试。

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use danmubox_core::ports::UserProfile;
use danmubox_core::{ConfigStore, Result};
use serde_json::Value;

use crate::http::BiliHttp;

/// 取一次头像的**上限**。
///
/// 与 `ws.rs` 的 `FACE_WAIT`（600ms）是两件事：那是「消费方愿意等多久才上屏」，
/// 这里管的是**取数本身**。一次挂住的请求会让后面所有 uid 的取数排队，而 reqwest 客户端
/// 本体的 15s 超时太长，因此在这一层再收一道。超时即空串（需求 3.3），下一条消息还能再试。
///
/// 注意「单飞」由 [`FACE_LOCKS`] 的 per-uid 锁保证，而不是把全局 `FACE_CACHE` 锁跨一次
/// 网络请求持有 —— 那样会让**别的 uid** 的取数也被串行堵在后面（修「头像缓存持锁做网络请求」）。
pub(crate) const FACE_FETCH_TIMEOUT: Duration = Duration::from_secs(3);

/// 进程内头像缓存：`uid -> 头像地址`。
///
/// **必须在进程级**（与 `http.rs` 的 `WBI_KEY_CACHE` 同一理由）：桌面端与 CLI 都可能
/// 逐次新建本实现，缓存放在实例字段里等于没缓存。账号无关（资料是公开数据），一个槽位即可。
///
/// 槽位里只会有**取到的那一份**：失败不写（需求 3.4），因此「命中」等价于
/// 「这个 uid 问过一次并且拿到了」。
static FACE_CACHE: LazyLock<tokio::sync::Mutex<HashMap<i64, String>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// 每个 uid 一把「在途锁」：**同一 uid 串行（单飞），不同 uid 各用各的、并行不互斥**。
///
/// 这是「头像缓存持锁做网络请求」的修复核心：原先 [`FACE_CACHE`] 的全局锁跨一次
/// `fetch_face` 的网络 `await`，于是任意两个不同 uid 的取数也被串行堵住。改成 per-uid 锁后，
/// 全局缓存锁只在「极短的检查 / 写入」时持有（不含网络），不同 uid 真正并发打上游，
/// 同一 uid 仍只打一次（需求 3.4）。表本身是 `std::sync::Mutex`（只做同步的查 / 插 `Arc`，
/// 从不在持有时 `await`），`Arc` 指向的 `tokio::sync::Mutex` 才在 `await` 点持有。
static FACE_LOCKS: LazyLock<std::sync::Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// 仅测试：清空进程级头像缓存（与 `http.rs` 的 [`crate::http::CACHE_TEST_LOCK`] 成对使用）。
///
/// 与 WBI 密钥缓存同一理由：它是**进程级**的，用例之间会互相喂到对方的结论
/// （`ws.rs` 那边「上游慢 2 秒」的用例会因此拿到别的用例先填好的头像）。
#[cfg(test)]
pub(crate) async fn reset_face_cache() {
    FACE_CACHE.lock().await.clear();
}

/// 只读校准用的原始读回（`danmubox-cli face <uid>`）：上游信封里与人有关的那三项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceProbe {
    /// 上游 `code`；缺失记 `-1`（不赋语义，只原样带回）。
    pub code: i64,
    /// 上游 `message` 原文（不含任何凭据：本层只回显上游原话的前缀）。
    pub message: String,
    /// `data.face` 原样（**未**做 https 升级，便于看清上游到底给了什么）。
    pub face: String,
}

/// 从 `x/space/wbi/acc/info` 的响应里取头像（纯函数，便于离线覆盖）。
///
/// `code != 0` 或 `data.face` 取不到 / 为空串 → `None`。**不猜**：非 0 code 一律按
/// 「没有头像」处理（`docs/protocol.md` 附录 A 只登记数值本身，本层不给它赋语义）。
pub fn parse_face(value: &Value) -> Option<String> {
    if value.get("code").and_then(Value::as_i64) != Some(0) {
        return None;
    }
    let face = value
        .pointer("/data/face")
        .and_then(Value::as_str)
        .unwrap_or_default();
    (!face.is_empty()).then(|| face.to_string())
}

/// 按 uid 取头像的实现（`docs/contract.md` §3 `UserProfile`）。
pub struct BiliProfile {
    http: BiliHttp,
}

impl BiliProfile {
    /// 游客态客户端（校准用：`danmubox-cli face` 不带 `--config` 时也能跑）。
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: BiliHttp::new()?,
        })
    }

    /// `cookie` 为完整 Cookie 串；`None` 即游客态。
    pub fn with_cookie(cookie: Option<String>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_cookie(cookie)?,
        })
    }

    /// 凭据来自凭据文件（登录态 / 游客态由文件内容决定）。
    pub fn with_store(store: Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(store)?,
        })
    }

    /// 复用一份**已有**的客户端。
    ///
    /// `ws.rs` 的房间运行时已经持有一个（Cookie 来源、连接池、超时都在它身上），
    /// 再新建一个只会多一份连接池与一处 Cookie 状态源。
    pub(crate) fn from_http(http: BiliHttp) -> Self {
        Self { http }
    }

    /// 只读校准入口：把上游的 `code` / `message` / `data.face` **原样**带回。
    ///
    /// 与 [`UserProfile::face_of`] 的分工：后者只回答「有没有头像」（取不到即空串），
    /// 校准要看的却是「为什么没有」——非 0 code 的数值、上游 message 原文、以及风控码。
    /// 因此这里不吞任何东西，且**不写缓存**（校准动作不该改变运行时的结论）。
    /// 传输失败 / 非 JSON 应答仍走 `Err`（那条路上的诊断文案已经带上端点路径、HTTP 状态、
    /// `content-type` 与响应体开头，见 `http.rs` 的 `decode_failure`）。
    pub async fn probe(&self, uid: i64) -> Result<FaceProbe> {
        let value = self.http.acc_info(uid).await?;
        Ok(FaceProbe {
            code: value.get("code").and_then(Value::as_i64).unwrap_or(-1),
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect(),
            face: value
                .pointer("/data/face")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }

    /// 真去问一次上游；拿不到返回 `None`（调用方据此决定要不要写缓存）。
    async fn fetch_face(&self, uid: i64) -> Option<String> {
        let response = match tokio::time::timeout(FACE_FETCH_TIMEOUT, self.http.acc_info(uid)).await
        {
            Ok(Ok(value)) => value,
            Ok(Err(err)) => {
                // **不记 uid**：推送用户标识不进日志是全仓既有口径（`bus.rs` 去重那里同款注释）；
                // 「哪一条消息缺头像」在 `ws.rs` 侧本来就有 room_id 可比对。
                tracing::debug!(
                    target: "danmubox_bili::profile",
                    %err,
                    "按 uid 取头像失败，按无头像处理"
                );
                return None;
            }
            Err(_) => {
                tracing::debug!(
                    target: "danmubox_bili::profile",
                    timeout_ms = FACE_FETCH_TIMEOUT.as_millis() as u64,
                    "按 uid 取头像超时，按无头像处理"
                );
                return None;
            }
        };
        let face = parse_face(&response);
        if face.is_none() {
            // 非 0 code 只记原始值（与其余适配器同口径：不赋语义）。
            let code = response.get("code").and_then(Value::as_i64).unwrap_or(-1);
            tracing::debug!(
                target: "danmubox_bili::profile",
                code,
                "上游没有给出头像，按无头像处理（不写缓存）"
            );
        }
        // 上游头像地址混着 http / https（与表情图同一族 CDN），而客户端跑在安全上下文里：
        // 不升级的话 WebKit 会**静默**拦掉这张图（`asset.rs` 的模块文档记了这条实测）。
        face.map(|face| crate::asset::secure_url(&face))
    }
}

#[async_trait::async_trait]
impl UserProfile for BiliProfile {
    async fn face_of(&self, uid: i64) -> String {
        // 没有 uid 就没有来源：不问上游（系统消息、游客弹幕都会走到这里）。
        if uid <= 0 {
            return String::new();
        }
        // ① 先快速看一眼持久缓存（极短持锁，**不含网络请求**）。
        if let Some(face) = FACE_CACHE.lock().await.get(&uid).cloned() {
            return face;
        }
        // ② 取该 uid 的「在途锁」：同一 uid 串行（单飞），不同 uid 各用各的、并行不互斥
        //    —— 这就是把「跨网络的锁」从全局缓存锁换成 per-uid 锁的意义所在。
        let slot = {
            let mut locks = FACE_LOCKS.lock().expect("在途锁表");
            locks
                .entry(uid)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _held = slot.lock().await;
        // ③ 二次核对：并发同 uid 的后来者拿到锁后先看缓存，避免重复打上游（需求 3.4）。
        if let Some(face) = FACE_CACHE.lock().await.get(&uid).cloned() {
            return face;
        }
        // ④ 真正打上游（此时只持 per-uid 锁，不挡别的 uid 的取数）。
        let fetched = self.fetch_face(uid).await;
        match fetched {
            Some(face) => {
                FACE_CACHE.lock().await.insert(uid, face.clone());
                face
            }
            // 失败**不写缓存**：下一条消息（下一条大航海 / 礼物）还能再试。
            None => String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::test_support::{spawn_stub, Stub, NAV_OK};
    use crate::http::{reset_wbi_cache, BiliHttp, CACHE_TEST_LOCK};
    use serde_json::json;
    use std::time::Duration;

    /// 桩上**打到 `/acc`** 的请求数：`hits` 会把 WBI 那一跳（`/nav`）也算进去，
    /// 而本模块要断言的是「同一 uid 只问一次**资料**接口」。
    fn acc_hits(stub: &Stub) -> usize {
        stub.hits_on("/acc")
    }

    /// 桩住两跳（`/nav` 取 WBI 密钥 → `/acc` 取资料）；返回实现与桩。
    fn profile_with_stub(
        responses: &[(u16, &str, &str)],
    ) -> (BiliProfile, crate::http::test_support::Stub) {
        let stub = spawn_stub(responses, Duration::ZERO);
        let http = BiliHttp::new()
            .expect("客户端可建")
            .with_nav_url(format!("{}/nav", stub.base))
            .with_acc_info_url(format!("{}/acc", stub.base));
        (BiliProfile::from_http(http), stub)
    }

    const ACC_OK: &str = r#"{"code":0,"message":"0","data":{"mid":42,"name":"某舰长","face":"https://i0.hdslb.com/bfs/face/abc.jpg"}}"#;

    #[test]
    fn parse_face_reads_only_a_zero_code_face() {
        assert_eq!(
            parse_face(
                &json!({"code": 0, "data": {"face": "https://i0.hdslb.com/bfs/face/a.jpg"}})
            ),
            Some("https://i0.hdslb.com/bfs/face/a.jpg".to_string())
        );
        // 非 0 code 一律按「没有头像」处理：风控 / 权限 / 用户不存在都不赋语义。
        for code in [-352, -400, -403, -404, 12345] {
            assert_eq!(
                parse_face(&json!({"code": code, "data": {"face": "x"}})),
                None
            );
        }
        // code 缺失、data 缺失、face 为空串 / 非字符串 → 都没有头像，不编造。
        assert_eq!(parse_face(&json!({"data": {"face": "x"}})), None);
        assert_eq!(parse_face(&json!({"code": 0})), None);
        assert_eq!(parse_face(&json!({"code": 0, "data": {"face": ""}})), None);
        assert_eq!(parse_face(&json!({"code": 0, "data": {"face": 7}})), None);
    }

    /// 需求 3.4：同一 uid 只问一次上游（第二次直接命中进程级缓存）。
    #[tokio::test]
    async fn same_uid_asks_upstream_once() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (profile, stub) = profile_with_stub(&[
            (200, "application/json", NAV_OK),
            (200, "application/json", ACC_OK),
        ]);
        reset_wbi_cache().await;
        reset_face_cache().await;

        let first = profile.face_of(42).await;
        let second = profile.face_of(42).await;

        assert_eq!(first, "https://i0.hdslb.com/bfs/face/abc.jpg");
        assert_eq!(second, first, "第二次必须来自缓存、且是同一份结论");
        assert_eq!(acc_hits(&stub), 1, "同一 uid 只该打一次资料接口");
    }

    /// 需求 3.4：并发到达也只打一次（单飞）。三条一起发，都该拿到同一份结论。
    #[tokio::test]
    async fn concurrent_same_uid_asks_upstream_once() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (profile, stub) = profile_with_stub(&[
            (200, "application/json", NAV_OK),
            (200, "application/json", ACC_OK),
        ]);
        reset_wbi_cache().await;
        reset_face_cache().await;

        let (a, b, c) = tokio::join!(
            profile.face_of(42),
            profile.face_of(42),
            profile.face_of(42)
        );

        assert_eq!(a, "https://i0.hdslb.com/bfs/face/abc.jpg");
        assert_eq!(b, a);
        assert_eq!(c, a);
        assert_eq!(acc_hits(&stub), 1, "并发取同一 uid 只该打一次上游");
    }

    /// 需求 3.4 的后半句：**非 0 code 不写缓存**，下一条消息还能再试。
    #[tokio::test]
    async fn nonzero_code_is_not_cached_and_the_next_call_retries() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (profile, stub) = profile_with_stub(&[
            (200, "application/json", NAV_OK),
            (
                200,
                "application/json",
                r#"{"code":-352,"message":"风控校验失败"}"#,
            ),
            (200, "application/json", ACC_OK),
        ]);
        reset_wbi_cache().await;
        reset_face_cache().await;

        assert_eq!(profile.face_of(42).await, "", "非 0 code 按无头像处理");
        assert_eq!(
            profile.face_of(42).await,
            "https://i0.hdslb.com/bfs/face/abc.jpg",
            "上一次没拿到、这一次拿到了，就说明失败没被缓存"
        );
        assert_eq!(acc_hits(&stub), 2, "失败那次不写缓存，第二次必须再问");
    }

    /// 需求 3.3：传输 / 解码失败也是空串，不报错、不 panic；同样不写缓存。
    #[tokio::test]
    async fn transport_failure_is_an_empty_string_and_is_not_cached() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (profile, stub) = profile_with_stub(&[
            (200, "application/json", NAV_OK),
            (502, "text/html", "<html>502 Bad Gateway</html>"),
        ]);
        reset_wbi_cache().await;
        reset_face_cache().await;

        assert_eq!(profile.face_of(42).await, "");
        assert_eq!(acc_hits(&stub), 1);
    }

    /// `uid <= 0` 没有来源（系统消息 / 游客弹幕）：一个请求都不该发。
    #[tokio::test]
    async fn uid_without_a_value_never_asks_upstream() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (profile, stub) = profile_with_stub(&[(200, "application/json", NAV_OK)]);
        reset_wbi_cache().await;
        reset_face_cache().await;

        assert_eq!(profile.face_of(0).await, "");
        assert_eq!(profile.face_of(-1).await, "");
        assert_eq!(stub.hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    /// 上游给 `http://` 时升级成 `https://`（`asset.rs` 的实测理由：安全上下文里
    /// `http://` 子资源会被静默拦掉，头像会「什么都没显示、日志里也没线索」）。
    #[tokio::test]
    async fn insecure_face_url_is_upgraded_to_https() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (profile, _stub) = profile_with_stub(&[
            (200, "application/json", NAV_OK),
            (
                200,
                "application/json",
                r#"{"code":0,"data":{"face":"http://i0.hdslb.com/bfs/face/abc.jpg"}}"#,
            ),
        ]);
        reset_wbi_cache().await;
        reset_face_cache().await;

        assert_eq!(
            profile.face_of(42).await,
            "https://i0.hdslb.com/bfs/face/abc.jpg"
        );
    }

    /// 校准入口把上游原样的三项带回（`code` / `message` / `data.face`），
    /// 且**不写缓存**——校准不该改变运行时结论。
    #[tokio::test]
    async fn probe_returns_the_raw_envelope_without_touching_the_cache() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (profile, stub) = profile_with_stub(&[
            (200, "application/json", NAV_OK),
            (
                200,
                "application/json",
                r#"{"code":-404,"message":"啥都木有","data":null}"#,
            ),
            (200, "application/json", ACC_OK),
        ]);
        reset_wbi_cache().await;
        reset_face_cache().await;

        let probe = profile.probe(42).await.expect("桩应答可解析");
        assert_eq!(probe.code, -404);
        assert_eq!(probe.message, "啥都木有");
        assert_eq!(probe.face, "");
        // 校准之后端口照旧要自己去问一次（上面那次没有写缓存）。
        assert_eq!(
            profile.face_of(42).await,
            "https://i0.hdslb.com/bfs/face/abc.jpg"
        );
        assert_eq!(acc_hits(&stub), 2);
    }
}

//! 弹幕长连接的帧格式：16 字节大端头、载荷编码与子包递归拆分。
//!
//! 对应 `docs/protocol.md` §3–§6、§9。所有取值以该文档为唯一来源。
//! 本模块是 ac站协议细节的边界内实现，`danmubox-core` 不得引用。

use std::io::Read;

use danmubox_core::Counters;
use serde_json::Value;

/// 固定头长度。
pub const HEADER_LEN: usize = 16;
/// 单包解压结果上限（`docs/contract.md` §4）：16 MiB，防解压炸弹。
pub const MAX_DECOMPRESSED: usize = 16 << 20;
/// 子包递归嵌套上限（`docs/protocol.md` §9 的护栏）。
pub const MAX_DEPTH: usize = 4;

pub const OP_HEARTBEAT: u32 = 2;
pub const OP_POPULARITY: u32 = 3;
pub const OP_NOTICE: u32 = 5;
pub const OP_VERIFY: u32 = 7;
pub const OP_VERIFY_REPLY: u32 = 8;

pub const PROTOVER_JSON: u16 = 0;
pub const PROTOVER_HEARTBEAT: u16 = 1;
pub const PROTOVER_ZLIB: u16 = 2;
pub const PROTOVER_BROTLI: u16 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub packet_len: u32,
    pub header_len: u16,
    pub protover: u16,
    pub op: u32,
    pub seq: u32,
}

impl Header {
    pub fn parse(buf: &[u8]) -> Option<Self> {
        if buf.len() < HEADER_LEN {
            return None;
        }
        Some(Self {
            packet_len: u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]),
            header_len: u16::from_be_bytes([buf[4], buf[5]]),
            protover: u16::from_be_bytes([buf[6], buf[7]]),
            op: u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]),
            seq: u32::from_be_bytes([buf[12], buf[13], buf[14], buf[15]]),
        })
    }

    /// 头部自洽检查：头部长度至少 16、不超过总长，总长不超过实际数据。
    fn is_sane(&self, available: usize) -> bool {
        self.header_len as usize >= HEADER_LEN
            && (self.header_len as usize) <= self.packet_len as usize
            && (self.packet_len as usize) <= available
    }
}

/// 组包：头部 + body。`protover` 用于认证与心跳包时固定为 1。
pub fn build_packet(op: u32, protover: u16, body: &[u8]) -> Vec<u8> {
    let total = (HEADER_LEN + body.len()) as u32;
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(&total.to_be_bytes());
    out.extend_from_slice(&(HEADER_LEN as u16).to_be_bytes());
    out.extend_from_slice(&protover.to_be_bytes());
    out.extend_from_slice(&op.to_be_bytes());
    out.extend_from_slice(&1u32.to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// 拆出的一条业务载荷。
#[derive(Debug, Clone, PartialEq)]
pub enum Decoded {
    /// `op=5` 的业务 JSON（已展开到最内层子包）。
    Business(Value),
    /// `op=3` 人气值。
    Popularity(u32),
    /// `op=8` 认证回应。
    VerifyReply(Value),
    /// 其他 op（心跳等），仅记录。
    Other(u32),
}

/// 按流解码：一个 WebSocket 二进制帧里可能粘着多个包，
/// `op=5` 解压后还可能再套一层同样的包头，因此递归处理。
pub fn decode_stream(data: &[u8], counters: &Counters, out: &mut Vec<Decoded>) {
    decode_stream_at(data, counters, 0, out);
}

fn decode_stream_at(data: &[u8], counters: &Counters, depth: usize, out: &mut Vec<Decoded>) {
    if depth > MAX_DEPTH {
        Counters::bump(&counters.malformed_dropped);
        tracing::warn!(depth, "子包嵌套超过上限，丢弃剩余数据");
        return;
    }

    let mut rest = data;
    while rest.len() >= HEADER_LEN {
        let Some(header) = Header::parse(rest) else {
            Counters::bump(&counters.malformed_dropped);
            return;
        };
        if !header.is_sane(rest.len()) {
            Counters::bump(&counters.malformed_dropped);
            tracing::debug!(
                packet_len = header.packet_len,
                available = rest.len(),
                "包头不自洽，丢弃剩余数据"
            );
            return;
        }

        Counters::bump(&counters.packets);
        let body = &rest[header.header_len as usize..header.packet_len as usize];

        match header.protover {
            PROTOVER_ZLIB => {
                if let Some(inflated) =
                    inflate_limited(flate2::read::ZlibDecoder::new(body), counters)
                {
                    decode_stream_at(&inflated, counters, depth + 1, out);
                }
            }
            PROTOVER_BROTLI => {
                if let Some(inflated) =
                    inflate_limited(brotli::Decompressor::new(body, 16 * 1024), counters)
                {
                    decode_stream_at(&inflated, counters, depth + 1, out);
                }
            }
            PROTOVER_HEARTBEAT => match header.op {
                OP_POPULARITY => out.push(Decoded::Popularity(read_popularity(body))),
                // 认证回应与客户端认证包同帧头（protover=1），必须在这一支处理。
                OP_VERIFY_REPLY => match serde_json::from_slice::<Value>(body) {
                    Ok(value) => out.push(Decoded::VerifyReply(value)),
                    Err(err) => {
                        Counters::bump(&counters.malformed_dropped);
                        tracing::debug!(%err, "认证回应解析失败，丢弃");
                    }
                },
                _ => out.push(Decoded::Other(header.op)),
            },
            _ => match header.op {
                OP_NOTICE => match serde_json::from_slice::<Value>(body) {
                    Ok(value) => out.push(Decoded::Business(value)),
                    Err(err) => {
                        Counters::bump(&counters.malformed_dropped);
                        tracing::debug!(%err, "业务包 JSON 解析失败，丢弃");
                    }
                },
                OP_VERIFY_REPLY => match serde_json::from_slice::<Value>(body) {
                    Ok(value) => out.push(Decoded::VerifyReply(value)),
                    Err(err) => {
                        Counters::bump(&counters.malformed_dropped);
                        tracing::debug!(%err, "认证回应解析失败，丢弃");
                    }
                },
                OP_HEARTBEAT => out.push(Decoded::Other(OP_HEARTBEAT)),
                other => out.push(Decoded::Other(other)),
            },
        }

        rest = &rest[header.packet_len as usize..];
    }

    if !rest.is_empty() {
        // 尾部残留不足一个头，说明分包不完整。
        Counters::bump(&counters.malformed_dropped);
        tracing::debug!(left = rest.len(), "尾部残留不足一个包头，丢弃");
    }
}

/// 人气值 body：4 字节大端；历史上存在带 16 字节前缀的形态，一并兼容。
fn read_popularity(body: &[u8]) -> u32 {
    if body.len() == 4 {
        u32::from_be_bytes([body[0], body[1], body[2], body[3]])
    } else if body.len() >= 20 {
        u32::from_be_bytes([body[16], body[17], body[18], body[19]])
    } else if body.len() >= 4 {
        u32::from_be_bytes([body[0], body[1], body[2], body[3]])
    } else {
        0
    }
}

/// 边读边限流：解压炸弹在读满 16 MiB 时即被丢弃，不会先撑爆内存。
fn inflate_limited<R: Read>(mut reader: R, counters: &Counters) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => return Some(out),
            Ok(n) => {
                if out.len() + n > MAX_DECOMPRESSED {
                    Counters::bump(&counters.oversize_dropped);
                    tracing::warn!(limit = MAX_DECOMPRESSED, "解压结果超过上限，丢弃该包");
                    return None;
                }
                out.extend_from_slice(&buf[..n]);
            }
            Err(err) => {
                Counters::bump(&counters.decompress_errors);
                tracing::debug!(%err, "解压失败，丢弃该包");
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn counters() -> Counters {
        Counters::default()
    }

    fn zlib(bytes: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(bytes).unwrap();
        enc.finish().unwrap()
    }

    fn brotli(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
            enc.write_all(bytes).unwrap();
        }
        out
    }

    fn danmu_json(content: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "cmd": "DANMU_MSG",
            "info": [[0, 1, 25, 16777215, 0, 0, 0, "", 0], content, [1, "u", 0, 0, 0, 1], [0, "", "", 0]]
        }))
        .unwrap()
    }

    fn business_payloads(out: &[Decoded]) -> Vec<&Value> {
        out.iter()
            .filter_map(|d| match d {
                Decoded::Business(v) => Some(v),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn parses_single_plain_json_packet() {
        let c = counters();
        let mut out = Vec::new();
        decode_stream(
            &build_packet(OP_NOTICE, PROTOVER_JSON, &danmu_json("hi")),
            &c,
            &mut out,
        );
        let payloads = business_payloads(&out);
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0]["cmd"], "DANMU_MSG");
        assert_eq!(c.snapshot().packets, 1);
        assert_eq!(c.snapshot().malformed_dropped, 0);
    }

    #[test]
    fn parses_zlib_payload_of_contract_version_2() {
        let c = counters();
        let mut out = Vec::new();
        let inner = build_packet(OP_NOTICE, PROTOVER_JSON, &danmu_json("zlib"));
        decode_stream(
            &build_packet(OP_NOTICE, PROTOVER_ZLIB, &zlib(&inner)),
            &c,
            &mut out,
        );
        assert_eq!(business_payloads(&out).len(), 1);
        assert_eq!(c.snapshot().packets, 2, "外层 + 内层各计一次");
    }

    #[test]
    fn parses_brotli_payload_of_contract_version_3() {
        let c = counters();
        let mut out = Vec::new();
        let inner = build_packet(OP_NOTICE, PROTOVER_JSON, &danmu_json("brotli"));
        decode_stream(
            &build_packet(OP_NOTICE, PROTOVER_BROTLI, &brotli(&inner)),
            &c,
            &mut out,
        );
        assert_eq!(business_payloads(&out).len(), 1);
    }

    #[test]
    fn expands_nested_subpackets_inside_one_frame() {
        let c = counters();
        let mut out = Vec::new();
        let mut inner = Vec::new();
        for text in ["a", "b", "c"] {
            inner.extend_from_slice(&build_packet(OP_NOTICE, PROTOVER_JSON, &danmu_json(text)));
        }
        // 两层：brotli( zlib( 三个子包 ) )
        let mid = build_packet(OP_NOTICE, PROTOVER_ZLIB, &zlib(&inner));
        decode_stream(
            &build_packet(OP_NOTICE, PROTOVER_BROTLI, &brotli(&mid)),
            &c,
            &mut out,
        );
        assert_eq!(business_payloads(&out).len(), 3, "子包必须全部展开");
    }

    #[test]
    fn truncated_packet_is_dropped_without_panic() {
        let c = counters();
        let mut out = Vec::new();
        let mut frame = build_packet(OP_NOTICE, PROTOVER_JSON, &danmu_json("cut"));
        frame.truncate(frame.len() - 5);
        decode_stream(&frame, &c, &mut out);
        assert!(out.is_empty());
        assert_eq!(c.snapshot().malformed_dropped, 1);
    }

    #[test]
    fn insane_header_is_dropped() {
        let c = counters();
        let mut out = Vec::new();
        let mut frame = vec![0u8; HEADER_LEN];
        frame[0..4].copy_from_slice(&8u32.to_be_bytes()); // packet_len < header_len
        decode_stream(&frame, &c, &mut out);
        assert!(out.is_empty());
        assert_eq!(c.snapshot().malformed_dropped, 1);
    }

    #[test]
    fn oversize_decompression_is_dropped_and_counted() {
        let c = counters();
        let mut out = Vec::new();
        let bomb = vec![b'a'; MAX_DECOMPRESSED + 4096];
        decode_stream(
            &build_packet(OP_NOTICE, PROTOVER_ZLIB, &zlib(&bomb)),
            &c,
            &mut out,
        );
        assert!(out.is_empty());
        assert_eq!(c.snapshot().oversize_dropped, 1);
        assert_eq!(c.snapshot().decompress_errors, 0);
    }

    #[test]
    fn corrupt_zlib_is_counted_not_fatal() {
        let c = counters();
        let mut out = Vec::new();
        decode_stream(
            &build_packet(OP_NOTICE, PROTOVER_ZLIB, b"not-zlib"),
            &c,
            &mut out,
        );
        assert!(out.is_empty());
        assert_eq!(c.snapshot().decompress_errors, 1);
    }

    #[test]
    fn depth_beyond_limit_is_rejected() {
        let c = counters();
        let mut out = Vec::new();
        let mut frame = build_packet(OP_NOTICE, PROTOVER_JSON, &danmu_json("deep"));
        for _ in 0..(MAX_DEPTH + 2) {
            frame = build_packet(OP_NOTICE, PROTOVER_ZLIB, &zlib(&frame));
        }
        decode_stream(&frame, &c, &mut out);
        assert!(out.is_empty(), "超过嵌套上限不得解出内容");
        assert!(c.snapshot().malformed_dropped >= 1);
    }

    #[test]
    fn popularity_reads_big_endian_u32() {
        let c = counters();
        let mut out = Vec::new();
        decode_stream(
            &build_packet(OP_POPULARITY, PROTOVER_HEARTBEAT, &7u32.to_be_bytes()),
            &c,
            &mut out,
        );
        assert_eq!(out, vec![Decoded::Popularity(7)]);
    }

    #[test]
    fn verify_reply_is_parsed() {
        let c = counters();
        let mut out = Vec::new();
        decode_stream(
            &build_packet(OP_VERIFY_REPLY, PROTOVER_JSON, br#"{"code":0}"#),
            &c,
            &mut out,
        );
        match &out[0] {
            Decoded::VerifyReply(v) => assert_eq!(v["code"], 0),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn verify_reply_arrives_with_heartbeat_framing() {
        // 线上实测：认证回应与认证包同为 protover=1（`docs/protocol.md` §7）。
        let c = counters();
        let mut out = Vec::new();
        decode_stream(
            &build_packet(OP_VERIFY_REPLY, PROTOVER_HEARTBEAT, br#"{"code":0}"#),
            &c,
            &mut out,
        );
        match &out[0] {
            Decoded::VerifyReply(v) => assert_eq!(v["code"], 0),
            other => panic!("protover=1 的认证回应必须被识别，实得 {other:?}"),
        }
    }
}

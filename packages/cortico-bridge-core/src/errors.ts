/**
 * Error retcodes. The four-digit base is the OneBot v12 enumerated set, adopted verbatim
 * (specs/connect/data-protocol/action-response.md:43-78 @d533f0fca). v12 keeps 4xxxx/5xxxx
 * reserved (that file :93-95) — the bridge does not use them; CBP-specific codes live in
 * 60001..60008 (c1 §5.4). The OneBot v11 WS retcodes 1400/1401/1403/1404 (communication/
 * ws.md:42-45 @d4456ee70) map onto the 10001 family.
 */
export const RET = {
  OK: 0,
  BAD_REQUEST: 10001,
  UNSUPPORTED_ACTION: 10002,
  BAD_PARAM: 10003,
  UNSUPPORTED_PARAM: 10004,
  UNSUPPORTED_SEGMENT: 10005,
  BAD_SEGMENT_DATA: 10006,
  UNSUPPORTED_SEGMENT_DATA: 10007,
  BAD_HANDLER: 20001,
  INTERNAL_HANDLER_ERROR: 20002,
  V11_WS_BAD_REQUEST: 1400,
  V11_WS_UNAUTHORIZED: 1401,
  V11_WS_FORBIDDEN: 1403,
  V11_WS_NOT_FOUND: 1404,
  VERSION_MISMATCH: 60001,
  CAPABILITY_UNAVAILABLE: 60002,
  PAYLOAD_TOO_LARGE: 60003,
  UNKNOWN_SESSION: 60004,
  DOOR_CLOSED: 60005,
  PEER_UNREACHABLE: 60006,
  SEND_UNCERTAIN: 60007,
  DEGRADED: 60008,
} as const;

export type Retcode = (typeof RET)[keyof typeof RET];

export interface CbpError {
  code: number;
  message: string;
}

export function err(code: number, message: string): CbpError {
  return { code, message };
}

/**
 * N.E.K.O push_message rejection reasons → CBP retcodes (c1 §5.4 table; four values
 * verbatim from r-neko §5 / push_message_schema.py @52e973ed2).
 */
export type NekoReason = 'backpressure' | 'payload_too_large' | 'transport_error' | 'transport_unavailable';
export function nekoReasonToCode(reason: NekoReason): number {
  switch (reason) {
    case 'backpressure':
      return RET.PEER_UNREACHABLE;
    case 'payload_too_large':
      return RET.PAYLOAD_TOO_LARGE;
    case 'transport_error':
      return RET.INTERNAL_HANDLER_ERROR;
    case 'transport_unavailable':
      return RET.PEER_UNREACHABLE;
  }
}

/**
 * MaiBot CapabilityResult{success,result,error} (c1 §5.4) — an unauthorized capability
 * is host-enforced at load ("插件 {plugin_id} 未获授权能力: {capability}", authorization.py:58
 * @478f671e6) and surfaces as an unsupported param.
 */
export function maibotCapabilityErr(e: unknown): CbpError {
  return err(RET.UNSUPPORTED_PARAM, `maibot capability failed: ${String(e)}`);
}

/**
 * Koishi: `session.send` swallows errors and returns `[]` — only true inside listener
 * dispatch (C1-4). An empty array means "sent, unknown outcome" → 60007.
 */
export function koishiEmptySendToCode(result: unknown): number {
  return Array.isArray(result) && result.length === 0 ? RET.SEND_UNCERTAIN : RET.OK;
}

/** v11 WS retcode → CBP 10001 family; unknown codes pass through. */
export function v11RetcodeToCbp(code: number): number {
  switch (code) {
    case RET.V11_WS_BAD_REQUEST:
    case RET.V11_WS_UNAUTHORIZED:
    case RET.V11_WS_FORBIDDEN:
    case RET.V11_WS_NOT_FOUND:
      return RET.BAD_REQUEST;
    default:
      return code;
  }
}

/**
 * cortico-bridge-core — CBP v1 kernel. Zero framework knowledge (blueprint §2.1 decision 2:
 * a new framework means a new table in a world package, never a kernel change).
 * Runtime dependency: `ws` only (§1.3-1). Node >= 22.16.0 (§4.3 fleet floor).
 *
 * Module map (the nine pieces of §2.1/§2.2):
 *   frames      CBP v1 ten-type frames + defensive parseFrame
 *   segment     v11 segment vocabulary, unknown-segment fallback (C1-16, single point)
 *   envelope    msg/notice → EventEnvelope + TriggerMode tiering, meta keeps raw
 *   dedup       TTL map, cap 200
 *   driver      WS dial/listen dual role, backoff/handshake/heartbeat table
 *   negotiate   caps intersection, v-gate 60001, tools[] risk/confirm_required
 *   errors      v12 four-digit base + bridge 60001..60008 + four-family translation
 *   correlate   rid/echo in-flight table + tick liveness
 *   idempotency rid→reply cache for redelivered call frames (§5.1)
 *   redact      credential stripping for raw/args/logs (§3.4)
 *   pins        version pins snapshot (spec/pins.json is the fleet-wide source)
 */
export {
  type CbpError,
  RET,
  type Retcode,
  err,
  koishiEmptySendToCode,
  maibotCapabilityErr,
  nekoReasonToCode,
  type NekoReason,
  v11RetcodeToCbp,
} from './errors.js';
export {
  encodeFrame,
  type Actor,
  type Anon,
  FRAME_TYPES,
  type Frame,
  type FrameError,
  type FrameType,
  frameTsToIso,
  newHead,
  parseFrame,
  type Seg,
  type SelfDecl,
  type ToolAnn,
  type ToolRisk,
} from './frames.js';
export {
  CBP_FIRST_CLASS_TYPES,
  atAllSegment,
  coerceSegment,
  coerceSegments,
  cqToSegments,
  isAtAll,
  isCbpOnlyType,
  isKnownType,
  isWireType,
  plainText,
  renderSegment,
  renderSegments,
  segToCq,
  segmentsToCq,
  WIRE_SEGMENT_TYPES,
} from './segment.js';
export {
  EVENT_SUFFIXES,
  eventNamesFor,
  eventToEnvelope,
  msgToEnvelope,
  noticeToEnvelope,
  tsToIso,
  type BlobInput,
  type ContextDelivery,
  type EnvelopeOptions,
  type EventEnvelopeLike,
  type PushOptionsLike,
  type TriggerMode,
} from './envelope.js';
export { DEDUP_MAX, DEDUP_TTL_MS, TtlDedup } from './dedup.js';
export { IDEM_MAX, IDEM_TTL_MS, RidReplyCache, type IdemOptions } from './idempotency.js';
export { SENSITIVE_KEYS, redactJson, redactText } from './redact.js';
export {
  BridgeDriver,
  CALL_TIMEOUT_MS,
  HANDSHAKE_GUARD_MS,
  HANDSHAKE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  type DriverOptions,
  type DriverRole,
  type DriverState,
} from './driver.js';
export {
  CAPS,
  V_SUPPORT,
  checkToolAnn,
  checkVersion,
  intersectCaps,
  negotiateHello,
  negotiateReady,
  sanitizeTools,
  type AgentId,
  type Cap,
  type Negotiation,
} from './negotiate.js';
export {
  PendingTable,
  PENDING_MAX,
  PENDING_TTL_MS,
  TickWatch,
  TurnLedger,
  type PendingEntry,
  type TurnRecord,
} from './correlate.js';
export { PINS, loadPins, TURN_TTL_ENV, effectiveTurnTtlSeconds, type HostPin, type Pins } from './pins.js';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Cpu, GripVertical, RefreshCw, ShieldCheck } from 'lucide-react';

export interface SliderTrailPoint {
  x: number;
  y: number;
  t: number;
}

export interface AntiBotChallengePayload {
  antiBotMode: 'builtin' | 'turnstile' | 'off';
  turnstileSiteKey: string;
  challengeToken: string;
  captchaSvgDataUri: string;
  powSalt: string;
  powDifficulty: number;
  requireSlider: boolean;
  sliderTarget: number;
  expiresInSec: number;
  remainingAttempts: number;
  loginRateLimitMax: number;
}

export interface AntiBotSolution {
  captchaCode: string;
  powNonce: string;
  powReady: boolean;
  sliderPosition: number;
  sliderDurationMs: number;
  sliderTrail: SliderTrailPoint[];
  sliderAligned: boolean;
}

export const EMPTY_ANTIBOT_SOLUTION: AntiBotSolution = {
  captchaCode: '',
  powNonce: '',
  powReady: false,
  sliderPosition: 0,
  sliderDurationMs: 0,
  sliderTrail: [],
  sliderAligned: false,
};

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256AsciiBytes(str: string): Uint8Array {
  const len = str.length;
  const bitLen = len * 8;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  for (let i = 0; i < len; i++) buf[i] = str.charCodeAt(i) & 0xff;
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 4, bitLen, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false); ov.setUint32(4, h1, false); ov.setUint32(8, h2, false); ov.setUint32(12, h3, false);
  ov.setUint32(16, h4, false); ov.setUint32(20, h5, false); ov.setUint32(24, h6, false); ov.setUint32(28, h7, false);
  return out;
}

function hasZeroBits(digest: Uint8Array, bits: number): boolean {
  const full = Math.floor(bits / 8);
  const rem = bits % 8;
  for (let i = 0; i < full; i++) if (digest[i] !== 0) return false;
  if (rem > 0) {
    const mask = (0xff << (8 - rem)) & 0xff;
    if ((digest[full] & mask) !== 0) return false;
  }
  return true;
}

export function AntiBotCaptcha({
  challenge,
  solution,
  onChange,
  onRefresh,
}: {
  challenge: AntiBotChallengePayload;
  solution: AntiBotSolution;
  onChange: (next: AntiBotSolution) => void;
  onRefresh: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const dragStartTsRef = useRef(0);
  const trailRef = useRef<SliderTrailPoint[]>([]);
  const solutionRef = useRef(solution);
  solutionRef.current = solution;

  const [powSolving, setPowSolving] = useState(false);
  const [powElapsedMs, setPowElapsedMs] = useState<number | null>(null);

  useEffect(() => {
    if (!challenge.powSalt || !challenge.powDifficulty) return;
    let cancelled = false;
    setPowSolving(true);
    setPowElapsedMs(null);
    const started = performance.now();
    let iter = 0;

    const step = () => {
      if (cancelled) return;
      for (let i = 0; i < 3500; i++) {
        const candidate = (iter++).toString(36);
        if (hasZeroBits(sha256AsciiBytes(`${challenge.powSalt}:${candidate}`), challenge.powDifficulty)) {
          if (!cancelled) {
            setPowSolving(false);
            setPowElapsedMs(Math.round(performance.now() - started));
            onChange({ ...solutionRef.current, powNonce: candidate, powReady: true });
          }
          return;
        }
      }
      if (!cancelled) window.setTimeout(step, 0);
    };

    const timer = window.setTimeout(step, 20);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [challenge.powSalt, challenge.powDifficulty]);

  const updateSlider = (clientX: number, clientY: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const usable = Math.max(1, rect.width - 36);
    const clamped = Math.max(0, Math.min(100, Math.round(((clientX - rect.left - 18) / usable) * 100)));
    const elapsed = Math.max(1, Math.round(performance.now() - dragStartTsRef.current));
    if (trailRef.current.length < 48) {
      trailRef.current.push({ x: clamped, y: Math.round(clientY - rect.top), t: elapsed });
    }
    onChange({
      ...solutionRef.current,
      sliderPosition: clamped,
      sliderDurationMs: elapsed,
      sliderTrail: [...trailRef.current],
      sliderAligned: Math.abs(clamped - challenge.sliderTarget) <= 5,
    });
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    dragStartTsRef.current = performance.now();
    trailRef.current = [{ x: 0, y: 16, t: 0 }];
    e.currentTarget.setPointerCapture(e.pointerId);
    updateSlider(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    updateSlider(e.clientX, e.clientY);
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={onRefresh}
          title="点击刷新高强度防AI图形验证码"
          className="flex-1 min-w-0 h-[76px] rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 overflow-hidden flex items-center justify-center"
        >
          {challenge.captchaSvgDataUri ? (
            <img
              src={challenge.captchaSvgDataUri}
              alt="高强度防AI图形验证码"
              draggable={false}
              className="w-full h-full object-contain select-none pointer-events-none"
            />
          ) : (
            <span className="text-xs text-slate-400">加载验证码中...</span>
          )}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="刷新验证码"
          className="px-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:text-blue-600 flex flex-col items-center justify-center gap-1 shrink-0"
        >
          <RefreshCw className="w-4 h-4" />
          <span className="text-[10px]">换一张</span>
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          required
          maxLength={6}
          autoComplete="off"
          spellCheck={false}
          value={solution.captchaCode}
          onChange={(e) =>
            onChange({
              ...solution,
              captchaCode: e.target.value.toUpperCase().replace(/[^2-9A-Z]/g, '').slice(0, 6),
            })
          }
          placeholder="输入图中 6 位字符（不区分大小写）"
          className="flex-1 min-w-0 px-3 py-2 text-xs font-mono tracking-[0.22em] uppercase rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
        />
        <span className="text-[11px] font-mono text-slate-500">{solution.captchaCode.length}/6</span>
      </div>

      {challenge.requireSlider && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-amber-700 dark:text-amber-300 font-medium">
              {solution.sliderAligned ? '滑块轨迹对齐通过' : '多次失败触发增强验证：拖动滑块至蓝色目标槽位'}
            </span>
            <span className={solution.sliderAligned ? 'text-emerald-600 font-semibold font-mono' : 'text-slate-400 font-mono'}>
              {solution.sliderAligned ? 'OK' : `${solution.sliderPosition}%`}
            </span>
          </div>
          <div
            ref={trackRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={`relative h-9 rounded-lg border select-none touch-none cursor-ew-resize overflow-hidden ${
              solution.sliderAligned
                ? 'border-emerald-500/70 bg-emerald-50/70 dark:bg-emerald-950/30'
                : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900'
            }`}
          >
            <div
              style={{ left: `calc(${challenge.sliderTarget}% * (100% - 36px) / 100%)` }}
              className={`absolute top-1 bottom-1 w-9 rounded-md border-2 border-dashed ${
                solution.sliderAligned ? 'border-emerald-500 bg-emerald-500/15' : 'border-blue-500/80 bg-blue-500/15'
              }`}
            />
            <div
              style={{ left: `calc(${solution.sliderPosition}% * (100% - 36px) / 100%)` }}
              className={`absolute top-0.5 bottom-0.5 w-9 rounded-md flex items-center justify-center text-white ${
                solution.sliderAligned ? 'bg-emerald-600' : 'bg-blue-600'
              }`}
            >
              {solution.sliderAligned ? <Check className="w-4 h-4" /> : <GripVertical className="w-4 h-4" />}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <Cpu className={`w-3.5 h-3.5 ${solution.powReady ? 'text-emerald-600' : 'text-blue-600 animate-pulse'}`} />
          {powSolving
            ? `SHA-256 算力校验中 (${challenge.powDifficulty}-bit)...`
            : solution.powReady
            ? `PoW 算力通过 (${challenge.powDifficulty}-bit${powElapsedMs !== null ? ` · ${powElapsedMs}ms` : ''})`
            : '等待算力校验'}
        </span>
        <span className="inline-flex items-center gap-1 font-mono text-[10px]">
          <ShieldCheck className="w-3 h-3 text-blue-600" />
          IP-Bound · Single-Use
        </span>
      </div>
    </div>
  );
}

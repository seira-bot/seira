import {
  forwardRef,
  memo,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MAUS_COLORS, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { avatarMarks, type AvatarKind } from "@/lib/avatar-marks";
import { CARVED_BODIES, type CarvedBody, type CarvedBodyId } from "../../shared/carved-bodies";
import { mascotClock, usePrefersReducedMotion, type MascotTicket } from "./mascot-clock";
import { frameFloorMs, nextFrameAt } from "./mascot-motion";
import { seiraPictures } from "@/lib/seira-body";
import { hairGradientMap, hairPictures } from "@/lib/seira-hair";
import { accessorySprites, spritesViewBox } from "@/lib/seira-accessories";
import type { MascotAccessoryId } from "../../shared/mascot-accessories";

/** Where the face looks and how it feels. */
export type CarvedPose = {
  /** Gaze, -1..1 each way. */
  gx: number;
  gy: number;
  /** Startle, 0..1: round eyes, open mouth, stretched body. */
  wide: number;
  /** Eyelids, 0 open .. 1 shut. */
  shut: number;
  /** Smile curvature: 1 is the resting smile, below 0 a frown. */
  smile: number;
};

export const REST_POSE: CarvedPose = { gx: 0, gy: 0, wide: 0, shut: 0, smile: 1 };

const PIVOT = 150;

type Rect = { x: number; y: number; width: number; height: number; rx: number; transform: string };
export type CarvedGeometry = {
  body: string;
  eyes: [Rect, Rect];
  smile: { d: string; transform: string; opacity: number };
  open: { cx: number; cy: number; rx: number; ry: number; opacity: number };
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Every attribute the face needs for a pose. */
export function carvedGeometry(body: CarvedBody, p: CarvedPose): CarvedGeometry {
  const e = body.eyes;
  const ax = Math.abs(p.gx);
  const lean = -p.gx * 9;
  const sx = 1 - 0.06 * p.wide;
  const sy = 1 + 0.09 * p.wide;
  const spread = e.dx * (1 - 0.1 * ax) * (1 + 0.14 * p.wide);
  const cx = e.cx + p.gx * e.dx * 1.05;
  const cy = e.cy + p.gy * 16 - p.wide * e.h * 0.42;
  let w = e.w * (1 + 0.05 * ax);
  let h = e.h * (1 - 0.3 * ax);
  w += (e.round - w) * p.wide;
  h += (e.round * 1.08 - h) * p.wide;
  h *= 1 - 0.9 * p.shut;
  const tilt = -p.gx * 18 * (1 - p.wide);
  const eye = (side: -1 | 1): Rect => {
    const k = 1 - 0.1 * Math.max(0, side * -p.gx);
    const ew = w * k;
    const eh = Math.max(h * k, 0.5);
    const x = cx + side * spread;
    return {
      x: r2(x - ew / 2), y: r2(cy - eh / 2), width: r2(ew), height: r2(eh), rx: r2(Math.min(ew, eh) / 2),
      transform: `rotate(${r2(tilt)} ${r2(x)} ${r2(cy)})`,
    };
  };
  const mw = e.dx * 0.46;
  const half = mw * (1 - 0.25 * ax);
  const depth = mw * 0.5 * p.smile;
  const my = (e.mouthY ?? e.cy + e.h * 0.5 + e.dx * 0.42) + p.gy * 10;
  const gape = Math.max(0, p.wide);
  return {
    body: `translate(120 ${PIVOT}) rotate(${r2(lean)}) scale(${r2(sx * 1000) / 1000} ${r2(sy * 1000) / 1000}) translate(-120 ${-PIVOT})`,
    eyes: [eye(-1), eye(1)],
    smile: {
      d: `M${r2(cx - half)} ${r2(my - depth * 0.35)} Q${r2(cx)} ${r2(my + depth)} ${r2(cx + half)} ${r2(my - depth * 0.35)}`,
      transform: `rotate(${r2(tilt * 0.6)} ${r2(cx)} ${r2(my)})`,
      opacity: r2(1 - p.wide),
    },
    open: { cx: r2(cx), cy: r2(my + mw * 0.1), rx: r2(mw * 0.5 * gape), ry: r2(mw * 0.62 * gape), opacity: r2(gape) },
  };
}


function moodFor(state: MausState): Partial<CarvedPose> & { glance?: number } {
  switch (state) {
    case "surprised": case "alerting": case "scared": case "excited": case "celebrate": case "spawning": case "waking":
      return { wide: 1 };
    case "sleeping": case "powering-down":
      return { shut: 0.92, smile: 0.4, glance: 0 };
    case "drowsy": case "bored":
      return { shut: 0.55, smile: 0.6, glance: 0.3 };
    case "happy": case "laughing": case "proud": case "playful":
      return { smile: 1.5 };
    case "sad":
      return { smile: -0.8, gy: 0.6, glance: 0.3 };
    case "thinking":
      return { gx: 0.6, gy: -0.6, glance: 0 };
    case "searching": case "radar": case "orbit": case "curious":
      return { glance: 2.2 };
    case "working": case "writing": case "loading":
      return { gy: 0.5, glance: 0.6 };
    default:
      return {};
  }
}

const SETTLED = 0.001;
const settled = (a: number, b: number) => Math.abs(a - b) < SETTLED;

const STARTLE: ReadonlySet<MausMotion> = new Set(["arrive", "switch", "customize", "alert", "launch", "success", "celebrate", "surprise"]);
const GLANCES: ReadonlyArray<[number, number]> = [[0, 0], [0, 0], [-1, 0.25], [1, 0.25], [-0.8, 0.55], [0.8, 0.55], [-0.7, -0.4], [0.7, -0.4], [0, 0.5]];

function mix(hex: string, toward: string, t: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(toward.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 0xff) + ((((b >> s) & 0xff) - ((a >> s) & 0xff)) * t));
  return `#${[ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The flat style wants more punch than a gradient's mid tone: saturation lifted 15%. */
export function vivid(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return hex;
  const s = Math.min(1, (l > 0.5 ? d / (2 - max - min) : d / (max + min)) * 1.15);
  const h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (x: number) => {
    const t = (x + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return `#${[ch(h + 1 / 3), ch(h), ch(h - 1 / 3)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function carvedFills(body: CarvedBody, color: MausColor): { body: string; accent: string } {
  const accent = vivid(MAUS_COLORS[color] ?? MAUS_COLORS.green);
  if (body.paint === "bone") return { body: body.bone ?? "#f1ede6", accent };
  if (body.paint === "pale") return { body: mix(MAUS_COLORS[color] ?? MAUS_COLORS.green, "#ffffff", 0.86), accent };
  if (body.paint === "hair") return { body: greyColor(color) ? body.bone ?? "#d3d8df" : accent, accent };
  return { body: accent, accent };
}

const greyColor = (color: MausColor) => color === "silver" || color === "chrome";

/** The tint laid over the rendered hair: none for the grey colours, whose hair stays as rendered. */
export function hairTint(color: MausColor): string | null {
  return greyColor(color) ? null : vivid(MAUS_COLORS[color] ?? MAUS_COLORS.green);
}

export interface CarvedAvatarHandle {
  blink(): void;
  spin(): void;
}

export type CarvedAvatarProps = {
  body: CarvedBodyId;
  color: MausColor;
  size?: number;
  state?: MausState;
  motion?: MausMotion;
  motionKey?: number;
  gaze?: { x?: number; y?: number };
  trackPointer?: boolean;
  animated?: boolean;
  label?: string;
  kind?: AvatarKind;
  /** What a Seira hair style wears, drawn over the face. */
  accessories?: readonly MascotAccessoryId[];
};

const NO_ACCESSORIES: readonly MascotAccessoryId[] = [];

function CarvedAvatarComponent(
  { body: bodyId, color, size = 44, state = "idle", motion = "none", motionKey = 0, gaze, trackPointer = true, animated = true, label, kind, accessories = NO_ACCESSORIES }: CarvedAvatarProps,
  ref: React.Ref<CarvedAvatarHandle>,
) {
  const body = CARVED_BODIES[bodyId];
  const density = globalThis.devicePixelRatio ?? 1;
  const seira = bodyId === "seira" ? seiraPictures(size, density) : null;
  const styled = seira ? null : hairPictures(bodyId, size, density);
  const pictures = seira ?? styled;
  const sprites = accessorySprites(bodyId, accessories, body.eyes);
  const uid = useId().replace(/:/g, "");
  const reduced = usePrefersReducedMotion();
  const live = animated && !reduced;
  const group = useRef<SVGGElement>(null);
  const eyes = [useRef<SVGRectElement>(null), useRef<SVGRectElement>(null)] as const;
  const smile = useRef<SVGPathElement>(null);
  const open = useRef<SVGEllipseElement>(null);
  const pose = useRef<CarvedPose>(moodPose(state));
  const cue = useRef({ blinkAt: -1, startleUntil: 0, pointer: null as null | { x: number; y: number } });
  const props = useRef({ state, gaze });
  props.current = { state, gaze };
  const ticket = useRef<MascotTicket | null>(null);
  const wake = () => ticket.current?.wake();
  const [initial] = useState(() => carvedGeometry(body, pose.current));

  const blink = () => {
    cue.current.blinkAt = performance.now();
    wake();
  };
  const startle = () => {
    cue.current.startleUntil = performance.now() + 1100;
    blink();
  };
  useImperativeHandle(ref, () => ({ blink, spin: startle }));

  useEffect(() => {
    if (!live || motion === "none") return;
    if (motion === "blink") blink();
    else if (STARTLE.has(motion)) startle();
  }, [motion, motionKey, live]);

  useEffect(wake, [state, gaze?.x, gaze?.y]);

  const paint = (p: CarvedPose) => {
    const g = carvedGeometry(body, p);
    group.current?.setAttribute("transform", g.body);
    g.eyes.forEach((rect, i) => {
      const el = eyes[i].current;
      if (!el) return;
      for (const [k, v] of Object.entries(rect)) el.setAttribute(k, String(v));
    });
    if (smile.current) {
      smile.current.setAttribute("d", g.smile.d);
      smile.current.setAttribute("transform", g.smile.transform);
      smile.current.setAttribute("opacity", String(g.smile.opacity));
    }
    if (open.current) for (const [k, v] of Object.entries(g.open)) open.current.setAttribute(k, String(v));
  };

  useEffect(() => {
    if (live) return;
    pose.current = moodPose(state);
    paint(pose.current);
  }, [state, live, body]);

  useEffect(() => {
    if (!live) return;
    let last = performance.now();
    let glanceAt = last + 900 + Math.random() * 2600;
    let blinkAt = last + 1500 + Math.random() * 3500;
    let target: [number, number] = [0, 0];
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const mood = moodFor(props.current.state);
      const rate = mood.glance ?? 1;
      if (rate > 0 && now > glanceAt) {
        target = GLANCES[Math.floor(Math.random() * GLANCES.length)];
        glanceAt = now + (1400 + Math.random() * 3200) / rate;
      }
      if (now > blinkAt) {
        cue.current.blinkAt = now;
        blinkAt = now + 2600 + Math.random() * 4200;
      }
      const pointer = cue.current.pointer;
      const outside = props.current.gaze;
      const startled = now < cue.current.startleUntil;
      const want: CarvedPose = {
        gx: Math.max(-1, Math.min(1, pointer?.x ?? (mood.gx ?? (rate > 0 ? target[0] : 0)) + (outside?.x ?? 0))),
        gy: Math.max(-1, Math.min(1, pointer?.y ?? (mood.gy ?? (rate > 0 ? target[1] : 0)) + (outside?.y ?? 0))),
        wide: startled ? 1 : mood.wide ?? 0,
        shut: mood.shut ?? 0,
        smile: mood.smile ?? 1,
      };
      const p = pose.current;
      const k = (speed: number) => 1 - Math.exp(-dt * speed);
      p.gx += (want.gx - p.gx) * k(9);
      p.gy += (want.gy - p.gy) * k(9);
      p.wide += (want.wide - p.wide) * k(want.wide > p.wide ? 18 : 7);
      p.smile += (want.smile - p.smile) * k(8);
      const since = cue.current.blinkAt < 0 ? 1 : (now - cue.current.blinkAt) / 200;
      const lid = since >= 1 ? 0 : since < 0.45 ? since / 0.45 : 1 - (since - 0.45) / 0.55;
      p.shut += (Math.max(want.shut, lid) - p.shut) * (lid > 0 ? 1 : k(10));
      const still = since >= 1 && !startled
        && settled(p.gx, want.gx) && settled(p.gy, want.gy) && settled(p.wide, want.wide)
        && settled(p.smile, want.smile) && settled(p.shut, want.shut);
      if (still) Object.assign(p, want);
      paint(p);
      return still ? Math.min(rate > 0 ? glanceAt : Infinity, blinkAt) : nextFrameAt(now, frameFloorMs(size));
    };
    ticket.current = mascotClock().add(step, group.current?.ownerSVGElement);
    return () => {
      ticket.current?.remove();
      ticket.current = null;
    };
  }, [body, live, size]);

  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    cue.current.pointer = {
      x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)),
      y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1)),
    };
    wake();
  };
  const onPointerLeave = () => {
    cue.current.pointer = null;
    wake();
  };

  const fills = carvedFills(body, color);
  const tint = pictures ? hairTint(color) : null;
  const hairMap = styled?.hair && tint ? hairGradientMap(tint) : null;
  const glow = pictures ? `url(#glow-${uid})` : undefined;
  const resolve = (fill: string) => (fill === "body" ? fills.body : fill === "accent" ? fills.accent : fill);
  return (
    <span
      {...avatarMarks(kind, "mascot")}
      className="inline-flex shrink-0"
      onPointerMove={trackPointer && live ? onPointerMove : undefined}
      onPointerLeave={trackPointer && live ? onPointerLeave : undefined}
    >
      <svg
        viewBox={spritesViewBox(sprites)}
        width={`${size}px`}
        height={`${size}px`}
        role={label ? "img" : undefined}
        aria-label={label ?? undefined}
        aria-hidden={label ? undefined : true}
        data-carved-body={body.id}
        style={{ overflow: "visible" }}
      >
        <defs>
          <clipPath id={`carved-${uid}`}><path d={body.clip} /></clipPath>
          {pictures && (
            <filter id={`glow-${uid}`} x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="3.5" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          )}
          {hairMap && (
            <filter id={`hair-${uid}`} colorInterpolationFilters="sRGB">
              <feComponentTransfer>
                <feFuncR type="table" tableValues={hairMap[0]} />
                <feFuncG type="table" tableValues={hairMap[1]} />
                <feFuncB type="table" tableValues={hairMap[2]} />
              </feComponentTransfer>
            </filter>
          )}
          {seira && tint && (
            <mask id={`hair-${uid}`} maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="240">
              <image href={seira.hair} x="0" y="0" width="240" height="240" />
            </mask>
          )}
        </defs>
        <g ref={group} transform={initial.body}>
          {pictures ? (
            <g style={{ isolation: "isolate" }}>
              <image href={pictures.head} x="0" y="0" width="240" height="240" />
              {seira && tint && <rect x="0" y="0" width="240" height="240" fill={tint} mask={`url(#hair-${uid})`} style={{ mixBlendMode: "multiply" }} />}
              {styled?.hair && hairMap && <image href={styled.hair} x="0" y="0" width="240" height="240" filter={`url(#hair-${uid})`} />}
            </g>
          ) : body.parts.map((part, i) => <path key={i} d={part.d} fill={resolve(part.fill)} />)}
          <g clipPath={`url(#carved-${uid})`} filter={glow}>
            {initial.eyes.map((rect, i) => <rect key={i} ref={eyes[i]} {...rect} fill={body.eyes.ink} />)}
          </g>
          {body.eyes.mouth && (
            <g filter={glow}>
              <path ref={smile} d={initial.smile.d} transform={initial.smile.transform} opacity={initial.smile.opacity}
                fill="none" stroke={body.eyes.mouthInk} strokeWidth={body.eyes.w * 0.36} strokeLinecap="round" />
              <ellipse ref={open} {...initial.open} fill={body.eyes.mouthInk} />
            </g>
          )}
          {sprites.map((sprite) => (
            <image key={sprite.id} href={sprite.href} x={sprite.x} y={sprite.y} width={sprite.width} height={sprite.height} data-accessory={sprite.id} />
          ))}
        </g>
      </svg>
    </span>
  );
}

function moodPose(state: MausState): CarvedPose {
  const m = moodFor(state);
  return { gx: m.gx ?? 0, gy: m.gy ?? 0, wide: m.wide ?? 0, shut: m.shut ?? 0, smile: m.smile ?? 1 };
}

export const CarvedAvatar = memo(forwardRef(CarvedAvatarComponent));

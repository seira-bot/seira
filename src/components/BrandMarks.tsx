import { useId, type ComponentType } from "react";
import { cn } from "@/lib/cn";
import { FADED_PROVIDER_MARK, type ProviderMarkTone } from "./provider-mark-fade";

export interface BrandMarkProps {
  size?: number;
  className?: string;
}

/** OpenAI's blossom from openai.com/brand, in the text colour: OpenAI ships it black for light and white for dark. */
export function OpenAIMark({ size = 16, className }: BrandMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 260" preserveAspectRatio="xMidYMid" className={cn("fill-[var(--color-ink)]", className)} aria-hidden="true">
      <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
    </svg>
  );
}

/** Codex's mark from Lobe Icons 1.104.0 (MIT), with its own gradient and without the app tile. */
export function CodexMark({ size = 16, className }: BrandMarkProps) {
  const id = useId().replace(/\W/gu, "");
  return <svg width={size} height={size} viewBox="2 2 20 20" className={className} aria-hidden="true">
    <defs>
      <linearGradient id={`${id}g`} x1="12" x2="12" y1="3" y2="21" gradientUnits="userSpaceOnUse"><stop stopColor="#B1A7FF" /><stop offset=".5" stopColor="#7A9DFF" /><stop offset="1" stopColor="#3941FF" /></linearGradient>
    </defs>
    <path fill={`url(#${id}g)`} d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" />
  </svg>;
}

/** xAI's mark from Lobe Icons 1.104.0 (MIT), in the text colour: xAI ships it black for light and white for dark. */
export function XaiMark({ size = 16, className }: BrandMarkProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fillRule="evenodd" className={cn("fill-[var(--color-ink)]", className)} aria-hidden="true">
    <path d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z" />
  </svg>;
}

/** Gemini's current spark from Lobe Icons 1.104.0 (MIT), in Google's blue with its green, red and yellow blends. */
export function GeminiMark({ size = 16, className }: BrandMarkProps) {
  const id = useId().replace(/\W/gu, "");
  const d = "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";
  return <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <defs>
      <linearGradient id={`${id}a`} x1="7" x2="11" y1="15.5" y2="12" gradientUnits="userSpaceOnUse"><stop stopColor="#08B962" /><stop offset="1" stopColor="#08B962" stopOpacity="0" /></linearGradient>
      <linearGradient id={`${id}b`} x1="8" x2="11.5" y1="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop stopColor="#F94543" /><stop offset="1" stopColor="#F94543" stopOpacity="0" /></linearGradient>
      <linearGradient id={`${id}c`} x1="3.5" x2="17.5" y1="13.5" y2="12" gradientUnits="userSpaceOnUse"><stop stopColor="#FABC12" /><stop offset=".46" stopColor="#FABC12" stopOpacity="0" /></linearGradient>
    </defs>
    <path fill="#3186FF" d={d} />
    <path fill={`url(#${id}a)`} d={d} />
    <path fill={`url(#${id}b)`} d={d} />
    <path fill={`url(#${id}c)`} d={d} />
  </svg>;
}

/** Cloudflare's cloud from Lobe Icons 1.104.0 (MIT), in the two oranges of cloudflare.com/logo. */
export function CloudflareMark({ size = 16, className }: BrandMarkProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path fill="#F38020" d="M16.493 17.4c.135-.52.08-.983-.161-1.338-.215-.328-.592-.519-1.05-.519l-8.663-.109a.148.148 0 01-.135-.082c-.027-.054-.027-.109-.027-.163.027-.082.108-.164.189-.164l8.744-.11c1.05-.054 2.153-.9 2.556-1.937l.511-1.31c.027-.055.027-.11.027-.164C17.92 8.91 15.66 7 12.942 7c-2.503 0-4.628 1.638-5.381 3.903a2.432 2.432 0 00-1.803-.491c-1.21.109-2.153 1.092-2.287 2.32-.027.328 0 .628.054.9C1.56 13.688 0 15.326 0 17.319c0 .19.027.355.027.545 0 .082.08.137.161.137h15.983c.08 0 .188-.055.215-.164l.107-.437" />
    <path fill="#FCAD32" d="M19.238 11.75h-.242c-.054 0-.108.054-.135.109l-.35 1.2c-.134.52-.08.983.162 1.338.215.328.592.518 1.05.518l1.855.11c.054 0 .108.027.135.082.027.054.027.109.027.163-.027.082-.108.164-.188.164l-1.91.11c-1.05.054-2.153.9-2.557 1.937l-.134.355c-.027.055.026.137.107.137h6.592c.081 0 .162-.055.162-.137.107-.41.188-.846.188-1.31-.027-2.62-2.153-4.777-4.762-4.777" />
  </svg>;
}

/** MiniMax's mark from Lobe Icons 1.104.0 (MIT), with its own gradient. */
export function MiniMaxMark({ size = 16, className }: BrandMarkProps) {
  const id = useId().replace(/\W/gu, "");
  return <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <defs>
      <linearGradient id={`${id}g`} x1="0%" x2="100.182%" y1="50.057%" y2="50.057%"><stop offset="0%" stopColor="#E2167E" /><stop offset="100%" stopColor="#FE603C" /></linearGradient>
    </defs>
    <path fill={`url(#${id}g)`} d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z" />
  </svg>;
}

/** ElevenLabs's mark from Simple Icons 16.38.0 (CC0 1.0), per elevenlabs.io/brand, in the text colour. */
export function ElevenLabsMark({ size = 16, className }: BrandMarkProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className={cn("fill-[var(--color-ink)]", className)} aria-hidden="true">
    <path d="M4.6035 0v24h4.9317V0zm9.8613 0v24h4.9317V0z" />
  </svg>;
}

/** 1Password's mark from Simple Icons 16.38.0 (CC0 1.0), per 1password.com/press: a white keyhole on its blue. */
export function OnePasswordMark({ size = 16, className }: BrandMarkProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" fill="#FFFFFF" />
    <path fill="#145FE4" d="M12 0c6.627 0 12 5.373 12 12 0 6.628-5.373 12-12 12S0 18.628 0 12C0 5.373 5.373 0 12 0m-.893 4.86c-.485 0-.727.001-.913.095a.87.87 0 0 0-.378.379c-.094.185-.095.428-.095.912v2.747c0 .12 0 .182.016.238q.02.075.065.138a1 1 0 0 0 .175.162l.695.564c.113.092.17.139.19.194a.22.22 0 0 1 0 .15c-.02.056-.077.102-.19.194l-.695.564a1 1 0 0 0-.175.162.4.4 0 0 0-.065.138 1 1 0 0 0-.016.238v6.019c0 .485 0 .728.095.913a.87.87 0 0 0 .378.378c.186.094.428.094.913.094h1.786c.485 0 .727 0 .913-.094a.87.87 0 0 0 .378-.378c.095-.185.095-.428.095-.913v-2.747c0-.12 0-.182-.016-.238a.4.4 0 0 0-.065-.138 1 1 0 0 0-.175-.162l-.695-.564c-.113-.092-.17-.138-.191-.193a.22.22 0 0 1 0-.152c.02-.055.078-.1.19-.193l.696-.564a1 1 0 0 0 .175-.162.4.4 0 0 0 .065-.138 1 1 0 0 0 .016-.238V6.246c0-.484 0-.727-.095-.912a.87.87 0 0 0-.378-.379c-.186-.094-.428-.094-.913-.094Z" />
  </svg>;
}

/** LM Studio's mark from Simple Icons 16.38.0 (CC0 1.0), from files.lmstudio.ai, in the text colour. */
export function LmStudioMark({ size = 16, className }: BrandMarkProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className={cn("fill-[var(--color-ink)]", className)} aria-hidden="true">
    <path d="M14.025 0c3.492 0 5.237 0 6.571.68a6.24 6.24 0 0 1 2.725 2.724C24 4.738 24 6.484 24 9.975v4.05c0 3.492 0 5.237-.68 6.571a6.24 6.24 0 0 1-2.724 2.725c-1.334.679-3.08.679-6.571.679h-4.05c-3.492 0-5.237 0-6.571-.68A6.24 6.24 0 0 1 .68 20.597C0 19.262 0 17.516 0 14.025v-4.05c0-3.492 0-5.237.68-6.571A6.23 6.23 0 0 1 3.404.68C4.738 0 6.484 0 9.975 0zM7.688 16.313a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625zm-3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm-3-3.75a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625z" />
  </svg>;
}

/** Fish Audio's fish from docs.fish.audio/brand, in its two tones: the black part in the text colour. */
export function FishAudioMark({ size = 16, className }: BrandMarkProps) {
  return <svg width={size} height={size} viewBox="268 172 437 163" className={className} aria-hidden="true">
    <path fill="var(--color-ink)" d="M277.1 198c4.42 0 8 3.58 8 8v3.4c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-3.4c0-4.42 3.58-8 8-8zM310 200.7c4.42 0 8 3.58 8 8v14.7c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-14.7c0-4.42 3.58-8 8-8zM342.9 196.4c4.42 0 8 3.58 8 8v61.4c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-61.4c0-4.42 3.58-8 8-8zM375.9 190c4.42 0 8 3.58 8 8v4c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-4c0-4.42 3.58-8 8-8zM375.9 243.4c4.42 0 8 3.58 8 8v42.3c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-42.3c0-4.42 3.58-8 8-8zM663.7 183.2c4.42 0 8 3.58 8 8v44.2c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-44.2c0-4.42 3.58-8 8-8zM631.9 176.1c4.42 0 8 3.58 8 8v59.4c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-59.4c0-4.42 3.58-8 8-8zM599.9 173c4.42 0 8 3.58 8 8v70.6c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-70.6c0-4.42 3.58-8 8-8zM567.9 175c4.42 0 8 3.58 8 8v71.8c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-71.8c0-4.42 3.58-8 8-8zM536.1 179.9c4.42 0 8 3.58 8 8v91.1c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-91.1c0-4.42 3.58-8 8-8zM503.5 188.2c4.42 0 8 3.58 8 8v104.1c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-104.1c0-4.42 3.58-8 8-8zM471.6 202.1c4.42 0 8 3.58 8 8v99.8c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-99.8c0-4.42 3.58-8 8-8zM439.6 220.4c4.42 0 8 3.58 8 8v86.2c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-86.2c0-4.42 3.58-8 8-8zM695.7 202.1c4.42 0 8 3.58 8 8v22c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-22c0-4.42 3.58-8 8-8zM407.6 233.1c4.42 0 8 3.58 8 8v84.8c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-84.8c0-4.42 3.58-8 8-8z" />
    <path fill="#B1B3B4" d="M695.7 247.9c4.42 0 8 3.58 8 8v11.1c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-11.1c0-4.42 3.58-8 8-8zM663.7 254.6c4.42 0 8 3.58 8 8v31.4c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-31.4c0-4.42 3.58-8 8-8zM631.9 262.3c4.42 0 8 3.58 8 8v36.1c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-36.1c0-4.42 3.58-8 8-8zM599.9 268.7c4.42 0 8 3.58 8 8v35.6c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-35.6c0-4.42 3.58-8 8-8zM567.9 274.4c4.42 0 8 3.58 8 8v30c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-30c0-4.42 3.58-8 8-8zM536.1 297.3c4.42 0 8 3.58 8 8v5.4c0 4.42-3.58 8-8 8-4.42 0-8-3.58-8-8v-5.4c0-4.42 3.58-8 8-8z" />
  </svg>;
}

/** Composio's mark from composio.dev/logos, in the text colour. */
export function ComposioMark({ size = 16, className }: BrandMarkProps) {
  return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
    <path d="M58.5409 18.0442L22.4819 10.6695C20.1176 10.1841 17.8943 12.0003 17.8943 14.4116V31.4939V32.402V49.4842C17.8943 51.8955 20.1176 53.712 22.4819 53.2265L58.5409 45.8518" stroke="var(--color-ink)" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="10" strokeWidth="1.82758" />
    <path fill="var(--color-ink)" d="M30.6983 4.73539C30.6984 1.34782 34.161 -0.917709 37.2617 0.379183L37.4093 0.443562L37.4126 0.445442L56.7025 9.35428C58.3954 10.1174 59.4565 11.8082 59.4569 13.6442V21.1912C59.4569 23.9444 57.112 26.1189 54.3726 25.9069L32.5258 24.2763V39.6193L54.3692 37.9887L54.6252 37.9755C57.2487 37.9116 59.456 40.0302 59.4406 42.6889V50.2358C59.4406 52.086 58.3516 53.7519 56.6895 54.5248L56.6867 54.5257L37.413 63.4183L37.4135 63.4188C34.2705 64.8735 30.6983 62.5825 30.6983 59.1294V51.9373C30.5567 51.9931 30.405 52.0302 30.2458 52.0417L19.585 52.8093C18.6942 52.8733 17.9362 52.1673 17.9361 51.2742V43.3595C17.9361 43.0526 18.0277 42.7648 18.1851 42.5225L9.41491 43.1776H9.41164C6.67967 43.3713 4.33082 41.2037 4.33081 38.4614V25.4342C4.33101 22.6801 6.67776 20.5047 9.41823 20.7185H9.41775L17.9939 21.3585C17.9567 21.2261 17.9361 21.0869 17.9361 20.9431V12.6057C17.9361 11.3884 19.025 10.4599 20.227 10.6522L30.3783 12.2763C30.4899 12.2941 30.5967 12.3247 30.6983 12.3646V4.73539ZM54.5116 39.8111H54.5083L32.5258 41.452V50.9913L57.6135 45.7476V42.6823L57.6106 42.5272C57.5355 40.9328 56.1381 39.6842 54.5116 39.8111ZM17.5836 23.1607C17.7369 23.4005 17.8261 23.6847 17.8261 23.9882V40.1889C17.8261 40.3767 17.7909 40.5566 17.7289 40.7236L30.6983 39.7556V24.1395L17.5836 23.1607ZM32.5258 22.4436L54.5083 24.0845L54.5116 24.085L54.6675 24.093C56.2752 24.1322 57.6293 22.8309 57.6293 21.1912V18.0187L32.5258 12.7711V22.4436Z" />
  </svg>;
}

/** TypeSafe's mark from the typesafe.ai site logo, in the text colour. TypeSafe makes Jev. */
export function TypeSafeMark({ size = 16, className }: BrandMarkProps) {
  return <svg width={size} height={size} viewBox="0 0 16.487 24" className={cn("fill-[var(--color-ink)]", className)} aria-hidden="true">
    <path d="M 12.756 2.928 L 12.756 7.067 L 16.486 9.487 L 16.487 18.652 L 8.244 24 L 3.732 21.073 L 3.732 16.82 L 0 14.399 L 0 5.35 L 0.355 5.118 L 8.244 0 Z M 5.94 20.65 L 8.242 22.144 L 14.275 18.227 L 11.975 16.735 Z M 9.022 10.332 L 9.022 14.4 L 5.29 16.822 L 5.29 19.216 L 11.197 15.383 L 11.197 8.921 Z M 12.756 15.384 L 14.928 16.794 L 14.928 10.332 L 12.756 8.922 Z M 2.21 13.976 L 4.511 15.47 L 6.812 13.976 L 4.512 12.485 Z M 1.559 6.193 L 1.559 12.544 L 3.731 11.134 L 3.731 7.066 L 7.464 4.643 L 7.464 2.36 L 1.56 6.193 Z M 5.291 11.132 L 7.463 12.542 L 7.463 10.332 L 5.292 8.921 L 5.292 11.132 Z M 5.94 7.487 L 8.244 8.981 L 10.544 7.488 L 8.244 5.994 Z M 9.024 4.643 L 11.196 6.054 L 11.196 3.774 L 9.024 2.359 Z" />
  </svg>;
}

/** OpenRouter's mark from Simple Icons (CC0 1.0), in its slate. */
export function OpenRouterMark({ size = 16, className }: BrandMarkProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path fill="#94A3B8" d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.792.447-2.497.904-3.936 1.131v4.229c1.31.184 2.908.627 3.795 1.132 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918L24 15.038l-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" />
  </svg>;
}

/** Every brand mark by id, with how a subtle row fades it at rest: a coloured logo dims, a text-coloured one turns grey. */
export const BRAND_MARKS = {
  openai: { Mark: OpenAIMark, tone: "mono" },
  codex: { Mark: CodexMark, tone: "brand" },
  xai: { Mark: XaiMark, tone: "mono" },
  gemini: { Mark: GeminiMark, tone: "brand" },
  cloudflare: { Mark: CloudflareMark, tone: "brand" },
  minimax: { Mark: MiniMaxMark, tone: "brand" },
  elevenlabs: { Mark: ElevenLabsMark, tone: "mono" },
  onePassword: { Mark: OnePasswordMark, tone: "brand" },
  lmStudio: { Mark: LmStudioMark, tone: "mono" },
  fishAudio: { Mark: FishAudioMark, tone: "brand" },
  composio: { Mark: ComposioMark, tone: "mono" },
  typesafe: { Mark: TypeSafeMark, tone: "mono" },
  openrouter: { Mark: OpenRouterMark, tone: "brand" },
} as const satisfies Record<string, { Mark: ComponentType<BrandMarkProps>; tone: ProviderMarkTone }>;

export type BrandId = keyof typeof BRAND_MARKS;

/** A brand's mark by id. `subtle` fades it at rest and lifts it when the row is hovered or focused, as provider rows do. */
export function BrandMark({ brand, size = 16, className, subtle = false }: BrandMarkProps & { brand: BrandId; subtle?: boolean }) {
  const { Mark, tone } = BRAND_MARKS[brand];
  if (!subtle) return <Mark size={size} className={className} />;
  return (
    <span data-provider-mark={tone} data-brand-mark={brand} className={cn("inline-flex shrink-0 transition-opacity", FADED_PROVIDER_MARK[tone], className)} style={{ width: size, height: size }}>
      <Mark size={size} />
    </span>
  );
}

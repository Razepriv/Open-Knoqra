import ottoStill from '@knoqra/brand/assets/mascot/otto-head-cut.png';
import { useEffect, useRef, useState } from 'react';
import type { OttoMood } from '../../lib/otto';
import { useMediaQuery } from '../../lib/use-media-query';
import type { OttoScene } from './otto-scene';

export const OTTO_LABEL = 'Otto, the KNOQRA assistant';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** The still frame is 710 wide; Otto's head fills the first 530, its caption the rest. */
const STILL_ZOOM = 710 / 530;

export interface OttoHeadProps {
  mood: OttoMood;
  /** Width and height in CSS pixels. */
  size: number;
  /** Always show the still image, even where WebGL and motion are fine. */
  still?: boolean;
}

/** True when this browser can start a WebGL context. The probe context is released at once. */
function canUseWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** The still frame, zoomed so the caption beside Otto's head falls outside the box. */
function StillImage({ size, alt }: { size: number; alt: string }) {
  return (
    <img
      src={ottoStill}
      alt={alt}
      width={Math.round(size * STILL_ZOOM)}
      className="absolute top-0 left-0 h-auto max-w-none select-none"
      style={{ width: size * STILL_ZOOM }}
      draggable={false}
    />
  );
}

/**
 * Otto's animated 3D head. three.js loads on demand in its own chunk; the still image holds the
 * place until the scene has drawn. Without WebGL, with reduced motion, when `still` is set, when
 * the scene fails to load or when the browser drops the WebGL context, it is the still image.
 */
export function OttoHead({ mood, size, still = false }: OttoHeadProps) {
  const reduceMotion = useMediaQuery(REDUCED_MOTION);
  const [webgl] = useState(canUseWebGL);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  const scene = useRef<OttoScene | null>(null);
  const moodRef = useRef(mood);
  const showStill = still || reduceMotion || !webgl || failed;

  useEffect(() => {
    moodRef.current = mood;
    scene.current?.setMood(mood);
  }, [mood]);

  useEffect(() => {
    const target = host.current;
    if (showStill || !target) return;
    let cancelled = false;
    const fail = () => {
      if (!cancelled) setFailed(true);
    };
    import('./otto-scene')
      .then(({ mountOtto }) => {
        if (cancelled) return;
        const mounted = mountOtto(target, { frame: 'head', still: false, onContextLost: fail });
        mounted.setMood(moodRef.current);
        scene.current = mounted;
        setReady(true);
      })
      .catch(fail);
    return () => {
      cancelled = true;
      scene.current?.dispose();
      scene.current = null;
      setReady(false);
    };
  }, [showStill]);

  const box = { width: size, height: size };
  if (showStill) {
    return (
      <span className="relative block shrink-0 overflow-hidden" style={box}>
        <StillImage size={size} alt={OTTO_LABEL} />
      </span>
    );
  }
  // The scene adds its canvas to this element. Until then the still frame stands in, unnamed,
  // because the element itself carries the name.
  return (
    <span
      ref={host}
      role="img"
      aria-label={OTTO_LABEL}
      className="relative block shrink-0 overflow-hidden"
      style={box}
    >
      {ready ? null : <StillImage size={size} alt="" />}
    </span>
  );
}

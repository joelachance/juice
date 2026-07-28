"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import styles from "./JuicePoster.module.css";

gsap.registerPlugin(useGSAP);

// Port of Pete Barr's "Adolescents — Swissted" pen
// (https://codepen.io/petebarr/pen/RwPzypW), straightened upright: a wall of
// the same word in misregistered ink that scrolls up one row per cycle,
// forever, while the incoming bottom row types itself in and a "ghost" row
// hops mid-wall.
//
// All type geometry is derived from the live container and the font's real
// measured width, so the whole word always fits no matter the column width or
// which face is loaded.

// The pen's proportions, expressed relative to font size.
const ROW_RATIO = 163 / 216; // row pitch: the loop scrolls exactly this
const MASK_RATIO = 192 / 216; // per-row overflow mask; chars enter through it
const GHOST_RATIO = 13 / 216; // ghost layer's vertical misregistration
const SIDE_INSET = 0.03; // breathing room each side, as a fraction of width
const PROBE_SIZE = 100; // font-size the hidden width probe renders at
const SCROLL_SECS = 5; // loop-local cycle length
const LOOP_TIME_SCALE = 0.5; // half-speed playback

type Metrics = {
  fontSize: number;
  rowH: number;
  maskH: number;
  ghost: number;
  inset: number;
  rows: number;
};

// Server and first client render share these so hydration matches; the real
// values land once the probe has measured the loaded font.
const INITIAL: Metrics = {
  fontSize: 100,
  rowH: 75,
  maskH: 89,
  ghost: 6,
  inset: 12,
  rows: 12,
};

export type JuicePosterProps = {
  word?: string;
};

export default function JuicePoster({ word = "JUICE" }: JuicePosterProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const masterRef = useRef<gsap.core.Timeline | null>(null);
  const [m, setMetrics] = useState<Metrics>(INITIAL);
  const [ready, setReady] = useState(false);

  const measure = useCallback(() => {
    const stage = stageRef.current;
    const probe = probeRef.current;
    if (!stage || !probe) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    // How wide the word actually is per 1px of font size, in the real face.
    const em = probe.getBoundingClientRect().width / PROBE_SIZE;
    if (!w || !h || !em) return;

    const fontSize = Math.round((w * (1 - SIDE_INSET * 2)) / em);
    const rowH = Math.round(fontSize * ROW_RATIO);
    const next: Metrics = {
      fontSize,
      rowH,
      maskH: Math.round(fontSize * MASK_RATIO),
      ghost: Math.round(fontSize * GHOST_RATIO),
      inset: Math.round(w * SIDE_INSET),
      // one spare row above the frame, one entering below it
      rows: Math.ceil(h / rowH) + 2,
    };

    setMetrics((prev) =>
      prev.fontSize === next.fontSize && prev.rows === next.rows ? prev : next,
    );
    setReady(true);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Measure once the real face is swapped in — fallback metrics would size
    // the wall against the wrong letterforms.
    document.fonts.ready.then(measure).catch(() => measure());
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  useGSAP(
    () => {
      const stage = stageRef.current;
      if (!stage || !ready) return;
      const q = gsap.utils.selector(stage);
      const lastRow = m.rows - 1;
      // the row whose ghost layer drops in mid-wall each cycle
      const midRow = Math.max(1, Math.floor(m.rows / 2) - 1);

      // The wall fades up in place — no slide, so the first frame reads as the
      // finished poster rather than as motion.
      const intro = gsap.timeline({ delay: 0.2 });
      intro.from(q("[data-content]"), {
        opacity: 0,
        duration: 1.6,
        ease: "power2.out",
      });

      const loop = gsap.timeline({ repeat: -1 });
      loop.timeScale(LOOP_TIME_SCALE);
      loop
        .to(q("[data-names]"), {
          y: -m.rowH,
          duration: SCROLL_SECS,
          ease: "none",
        })
        // Upright, the incoming row only crests the bottom edge late in the
        // cycle, so the type-in sits late too — but every char still lands
        // inside SCROLL_SECS or the repeat would outgrow the scroll and pop.
        .from(
          q(`[data-row="${lastRow}"][data-layer="ink"] [data-char]`),
          { y: m.maskH, duration: 2.5, ease: "power4", stagger: 0.1 },
          1.8,
        )
        .from(
          q(`[data-row="${lastRow}"][data-layer="ghost"] [data-char]`),
          { y: m.maskH, duration: 2.5, ease: "power4", stagger: 0.1 },
          2.1,
        )
        .from(
          q(`[data-row="${midRow}"][data-layer="ghost"] [data-char]`),
          { y: -m.maskH, duration: 2, ease: "power4.inOut", stagger: -0.1 },
          0,
        )
        .to(
          q(`[data-row="${midRow + 1}"][data-layer="ghost"] [data-char]`),
          { y: m.maskH, duration: 2, ease: "power4.inOut", stagger: -0.1 },
          0,
        );

      const master = gsap.timeline({ delay: 0.4 });
      master.add(intro).add(loop, 0);
      masterRef.current = master;

      if (process.env.NODE_ENV !== "production") {
        // Debug handle: lets devtools (and headless checks) scrub the timeline.
        (
          window as unknown as { __juicePosterTl?: gsap.core.Timeline }
        ).__juicePosterTl = master;
      }
    },
    { scope: stageRef, dependencies: [m, ready], revertOnUpdate: true },
  );

  const chars = word.split("");

  return (
    <div
      ref={stageRef}
      className={styles.stage}
      style={
        {
          opacity: ready ? 1 : 0,
          "--row-h": `${m.rowH}px`,
          "--mask-h": `${m.maskH}px`,
          "--font-size": `${m.fontSize}px`,
          "--ghost-offset": `${m.ghost}px`,
          "--content-top": `${-m.rowH}px`,
          "--content-left": `${m.inset}px`,
        } as React.CSSProperties
      }
      onClick={() => masterRef.current?.restart()}
    >
      <h1 className={styles.srOnly}>{word}</h1>
      <span ref={probeRef} className={styles.probe} aria-hidden="true">
        {word}
      </span>
      <div className={styles.content} data-content aria-hidden="true">
        {Array.from({ length: m.rows }, (_, row) => (
          <div className={styles.band} key={row}>
            <span className={styles.names} data-names>
              {(["ink", "ghost"] as const).map((layer) => (
                <span
                  key={layer}
                  className={
                    layer === "ink"
                      ? styles.name
                      : `${styles.name} ${styles.nameGhost}`
                  }
                  data-row={row}
                  data-layer={layer}
                >
                  {chars.map((c, i) => (
                    <span key={i} className={styles.char} data-char>
                      {c}
                    </span>
                  ))}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

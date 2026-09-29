import React from 'react';

export type FlowLogoSize = 'sm' | 'md' | 'lg';
export type FlowLogoVariant = 'default' | 'inverse';

/**
 * Fixed HEIGHT per named size only — width is always 'auto', so the browser
 * always scales proportionally from the master's natural dimensions. Never
 * add a fixed width alongside a fixed height here: that pairing is the one
 * thing that could stretch/distort the locked artwork. Add new sizes here,
 * never as ad-hoc height classes at a call site.
 */
const SIZE_HEIGHT: Record<FlowLogoSize, string> = {
  sm: '1.25rem', // compact navigation (mobile sidebar header)
  md: '1.5rem',  // desktop sidebar header
  lg: '4rem',    // login / change-password hero
};

interface FlowLogoProps {
  /** Named height preset; width always follows automatically. Default 'md'. */
  size?: FlowLogoSize;
  /**
   * 'default' (default value) renders the master exactly as approved —
   * black background, white type, unmodified pixels. This is every current
   * FLOW surface and must stay the default everywhere unless a page's
   * design explicitly calls for the other option.
   *
   * 'inverse' applies a lossless per-pixel color invert (`filter:
   * invert(1)`) of the SAME master file. Invert only remaps each pixel's
   * RGB value (new = 255 - old); it cannot move, resize, crop, or reshape a
   * pixel, so wordmark geometry, typography, the (R) hallmark, letter
   * spacing and proportions stay pixel-for-pixel identical to the master —
   * only the color treatment changes.
   *
   * IMPORTANT: 'inverse' is NOT a brand-approved dark colorway. No such
   * variant has ever been supplied or approved — this is only a
   * geometry-safe technical option (deliberately named to avoid implying
   * "dark mode" or any approved theme). No FLOW surface currently uses it.
   * Get explicit visual sign-off before applying it to any real page.
   */
  variant?: FlowLogoVariant;
  /**
   * Layout-only utilities (margin, centering, etc.). Never pass a width,
   * height, or color/filter utility here — use `size`/`variant` instead so
   * every call site keeps the aspect ratio and approved colors guaranteed.
   */
  className?: string;
}

/**
 * The one approved LUXARDO FLOW brand mark — the full black/white lockup
 * (wordmark + "FASHION ITALY" subtitle). LUXARDO FLOW (Loom) only — see
 * Logo.tsx for the unrelated B2C mark.
 *
 * The master artwork itself is locked: this component only ever changes
 * display height (`size`, width auto-follows) and, optionally, a lossless
 * color invert (`variant="inverse"` — NOT brand-approved, see above) of the
 * exact same file — never a redraw, crop, stretch, or substitute asset.
 */
export default function FlowLogo({ size = 'md', variant = 'default', className = '' }: FlowLogoProps) {
  return (
    <img
      src="/flow-logo.png"
      alt="LUXARDO FLOW"
      style={{
        height: SIZE_HEIGHT[size],
        width: 'auto',
        ...(variant === 'inverse' ? { filter: 'invert(1)' } : {}),
      }}
      className={className}
    />
  );
}

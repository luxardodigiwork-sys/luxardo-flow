import React from 'react';

export type FlowLogoSize = 'sm' | 'md' | 'lg';
export type FlowLogoVariant = 'default' | 'inverse';

/**
 * Per-size wordmark + tagline font sizes. Add new sizes here, never as
 * ad-hoc text-size classes at a call site.
 */
const SIZES: Record<FlowLogoSize, { wordmark: string; tagline: string; gap: string }> = {
  sm: { wordmark: 'text-sm', tagline: 'text-[8px]', gap: 'gap-0.5' },
  md: { wordmark: 'text-base', tagline: 'text-[9px]', gap: 'gap-0.5' },
  lg: { wordmark: 'text-2xl', tagline: 'text-[11px]', gap: 'gap-1' },
};

interface FlowLogoProps {
  /** Named size preset — controls wordmark + tagline font size together. Default 'md'. */
  size?: FlowLogoSize;
  /**
   * 'default' (default value) renders dark text — the wordmark in black,
   * the tagline in muted gray — for use on light surfaces (every current
   * FLOW surface except the dark-theme production sidebar).
   *
   * 'inverse' renders light text (white wordmark, muted light-gray
   * tagline) for use on a dark/black surface, e.g. ProductionLayout's
   * sidebar header when the dark theme is active.
   */
  variant?: FlowLogoVariant;
  /** Layout-only utilities (margin, centering, etc.). */
  className?: string;
}

/**
 * The LUXARDO FLOW brand lockup — plain text, no "FASHION ITALY" subtitle
 * (that belonged to the retired image-based mark). Two lines: the
 * "LUXARDO FLOW" wordmark, and the "Production Tracker" tagline beneath it.
 */
export default function FlowLogo({ size = 'md', variant = 'default', className = '' }: FlowLogoProps) {
  const { wordmark, tagline, gap } = SIZES[size];
  const wordmarkColor = variant === 'inverse' ? 'text-white' : 'text-black';
  const taglineColor = variant === 'inverse' ? 'text-gray-400' : 'text-gray-500';
  // 'lg' is only ever used standalone, centered on a login/change-password
  // hero — inline-flex (so an ancestor's text-align:center still centers
  // this box, exactly as the old <img> did) + items-center (so the shorter
  // tagline centers under the wordmark). 'sm'/'md' are only ever used
  // left-aligned inside the production sidebar header — items-start keeps
  // both lines flush to the shared left edge there.
  const alignCls = size === 'lg' ? 'inline-flex items-center' : 'flex items-start';

  return (
    <div className={`${alignCls} flex-col ${gap} ${className}`}>
      <span className={`font-display font-bold uppercase tracking-wide leading-none ${wordmark} ${wordmarkColor}`}>
        LUXARDO FLOW
      </span>
      <span className={`uppercase tracking-widest leading-none ${tagline} ${taglineColor}`}>
        Production Tracker
      </span>
    </div>
  );
}

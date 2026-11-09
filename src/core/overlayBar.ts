import type { OverlayBarPosition } from './settings';

/// Every number the bar lays out with. The pill is 36 high and at most
/// 132 + 92 wide; the window is 32px larger than that in each direction so the
/// shadow has somewhere to fall and the pill can grow without the window
/// resizing mid-spring.
export const BAR_METRICS = {
  height: 36,
  expandedWidth: 132,
  secondSegmentWidth: 92,
  maxExpandedWidth: 132 + 92,
  panelWidth: 132 + 92 + 32,
  panelHeight: 36 + 32,
  /// Deliberately smaller than the HUD's own bottom gap: when a click on this
  /// bar starts a dictation, the HUD appears above it, and the two need enough
  /// clearance not to touch.
  edgeGap: 14,
} as const;

export type BarAnchor = 'left' | 'center' | 'right';

export function anchorFor(position: OverlayBarPosition): BarAnchor {
  switch (position) {
    case 'bottomCenter': return 'center';
    case 'bottomLeft':
    case 'topLeft': return 'left';
    case 'bottomRight':
    case 'topRight': return 'right';
  }
}

/// Where the panel's top-left lands in a display's work area. Pure, so the
/// five positions can be checked without a screen.
export function barOrigin(
  area: { x: number; y: number; width: number; height: number },
  position: OverlayBarPosition,
): { x: number; y: number } {
  const { panelWidth, panelHeight, edgeGap } = BAR_METRICS;
  const bottom = area.y + area.height - panelHeight - edgeGap;
  const top = area.y + edgeGap;
  switch (position) {
    case 'bottomCenter': return { x: Math.round(area.x + (area.width - panelWidth) / 2), y: Math.round(bottom) };
    case 'bottomLeft': return { x: Math.round(area.x + edgeGap), y: Math.round(bottom) };
    case 'bottomRight': return { x: Math.round(area.x + area.width - panelWidth - edgeGap), y: Math.round(bottom) };
    case 'topLeft': return { x: Math.round(area.x + edgeGap), y: Math.round(top) };
    case 'topRight': return { x: Math.round(area.x + area.width - panelWidth - edgeGap), y: Math.round(top) };
  }
}

/// The quick-note bubble: wide and tall enough for a few real sentences without
/// feeling like a second window.
export const NOTE_BUBBLE = { width: 320, height: 160, gap: 10 } as const;

/// Above the bar, on the side facing away from whichever screen edge it is
/// docked to — "above" a bar someone has moved to the top of the screen would
/// run straight off it, so this checks room rather than assuming the common
/// bottom-docked case.
export function bubbleOrigin(
  pill: { x: number; y: number; width: number; height: number },
  area: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const { width, height, gap } = NOTE_BUBBLE;
  const above = pill.y - gap - height;
  const y = above >= area.y ? above : pill.y + pill.height + gap;
  const centred = Math.round(pill.x + pill.width / 2 - width / 2);
  const x = Math.min(Math.max(centred, area.x + gap), area.x + area.width - width - gap);
  return { x, y: Math.round(y) };
}

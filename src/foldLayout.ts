import type { AreaSize, FoldGeometry } from '../modules/gemma-fold';

export type Division = { axis: 'x' | 'y'; start: number; end: number };

type Insets = { top?: number; right?: number; bottom?: number; left?: number };

type ChatLayout = {
  sidebarWidth: number;
  sidebarGap: number;
  insets: Insets;
  transcriptHeight?: number;
  foldGap: number;
};

const singlePane: ChatLayout = { sidebarWidth: 0, sidebarGap: 0, insets: {}, foldGap: 0 };

export function getDivision(size: AreaSize, geometry: FoldGeometry | null): Division | null {
  const region = geometry?.division;
  // Native and JS resize independently. Ignore the old fold until both describe the same view.
  if (!region || Math.abs(geometry.width - size.width) > 1 || Math.abs(geometry.height - size.height) > 1) {
    return null;
  }

  const axis = region.height >= region.width ? 'x' : 'y';
  const limit = axis === 'x' ? size.width : size.height;
  const origin = axis === 'x' ? region.x : region.y;
  const extent = axis === 'x' ? region.width : region.height;
  const start = Math.max(0, origin);
  const end = Math.min(limit, origin + extent);
  return start < end ? { axis, start, end } : null;
}

export function getFoldInsets(size: AreaSize, division: Division | null): Insets {
  if (!division) return {};
  if (division.axis === 'x') {
    return division.start >= size.width - division.end ? { right: size.width - division.start } : { left: division.end };
  }
  return division.start >= size.height - division.end ? { bottom: size.height - division.start } : { top: division.end };
}

export function getChatLayout(
  size: AreaSize,
  division: Division | null,
  hasAttachment: boolean,
  fontScale: number,
): ChatLayout {
  if (division?.axis === 'x') {
    const trailingWidth = size.width - division.end;
    if (division.start >= 164 && trailingWidth >= 252) {
      return { ...singlePane, sidebarWidth: division.start, sidebarGap: division.end - division.start };
    }
  } else if (division?.axis === 'y') {
    const stackedActions = size.width < minInlineComposerWidth(fontScale);
    const minComposerHeight = (hasAttachment ? 132 : 76) + (stackedActions ? 48 : 0)
      + 30 * Math.max(0, fontScale - 1);
    if (division.start >= 136 && size.height - division.end >= minComposerHeight) {
      return { ...singlePane, transcriptHeight: division.start, foldGap: division.end - division.start };
    }
  } else if (size.width >= 570) {
    return { ...singlePane, sidebarWidth: Math.min(244, Math.round(size.width * 0.32)), sidebarGap: 12 };
  }

  return { ...singlePane, insets: getFoldInsets(size, division) };
}

export function minInlineComposerWidth(fontScale: number): number {
  return 280 + 36 * Math.max(0, fontScale - 1);
}

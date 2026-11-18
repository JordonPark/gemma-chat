type Size = { width: number; height: number };
type Point = { x: number; y: number };

export type ImageTransform = Point & { scale: number };
export const MAX_IMAGE_ZOOM = 4;

export function fitImage(viewport: Size, image: Size | null): Size {
  if (!image || image.width <= 0 || image.height <= 0) return viewport;
  const ratio = Math.min(viewport.width / image.width, viewport.height / image.height);
  return { width: image.width * ratio, height: image.height * ratio };
}

export function boundImage(transform: ImageTransform, fitted: Size, viewport: Size): ImageTransform {
  const limitX = Math.max(0, (fitted.width * transform.scale - viewport.width) / 2);
  const limitY = Math.max(0, (fitted.height * transform.scale - viewport.height) / 2);
  return {
    scale: transform.scale,
    x: Math.max(-limitX, Math.min(limitX, transform.x)),
    y: Math.max(-limitY, Math.min(limitY, transform.y)),
  };
}

export function zoomImage(
  start: ImageTransform,
  desiredScale: number,
  anchor: Point,
  current: Point = anchor,
): ImageTransform {
  const scale = Math.max(1, Math.min(MAX_IMAGE_ZOOM, desiredScale));
  const ratio = scale / start.scale;
  return {
    scale,
    x: current.x - (anchor.x - start.x) * ratio,
    y: current.y - (anchor.y - start.y) * ratio,
  };
}

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no canvas or layout. ascii-reveal draws on a canvas and measures text ranges, so stub
// the few browser APIs it touches. The tests assert markup and accessibility, not pixels.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;
const emptyRect = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
Range.prototype.getBoundingClientRect = () => ({ ...emptyRect, toJSON: () => ({}) }) as DOMRect;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

afterEach(() => cleanup());

import type { TodayWidget } from '@knoqra/core';
import { describe, expect, it } from 'vitest';
import { moveWidget, restoreWidget, swapWidgets, visibleWidgets } from './today';

const ORDER: readonly TodayWidget[] = ['streak', 'next', 'focus', 'otto'];

describe('moveWidget', () => {
  it('moves a widget one place earlier or later', () => {
    expect(moveWidget(ORDER, 'focus', -1)).toEqual(['streak', 'focus', 'next', 'otto']);
    expect(moveWidget(ORDER, 'next', 1)).toEqual(['streak', 'focus', 'next', 'otto']);
  });

  it('leaves the order as it is at either edge', () => {
    expect(moveWidget(ORDER, 'streak', -1)).toEqual(ORDER);
    expect(moveWidget(ORDER, 'otto', 1)).toEqual(ORDER);
  });

  it('leaves the order as it is for a widget that is not in it', () => {
    expect(moveWidget(['streak', 'next'], 'otto', -1)).toEqual(['streak', 'next']);
  });

  it('never mutates its input and always returns a new array', () => {
    const order: TodayWidget[] = [...ORDER];
    const frozen = Object.freeze([...ORDER]);
    const moved = moveWidget(order, 'otto', -1);
    expect(order).toEqual(ORDER);
    expect(moved).not.toBe(order);
    expect(moveWidget(order, 'streak', -1)).not.toBe(order);
    expect(() => moveWidget(frozen, 'focus', 1)).not.toThrow();
  });
});

describe('swapWidgets', () => {
  it('swaps two widgets wherever they are', () => {
    expect(swapWidgets(ORDER, 'streak', 'otto')).toEqual(['otto', 'next', 'focus', 'streak']);
  });

  it('is a copy when a widget is missing or both are the same', () => {
    expect(swapWidgets(ORDER, 'next', 'next')).toEqual(ORDER);
    expect(swapWidgets(['streak'], 'streak', 'otto')).toEqual(['streak']);
  });

  it('never mutates its input', () => {
    const frozen = Object.freeze([...ORDER]);
    expect(swapWidgets(frozen, 'next', 'focus')).toEqual(['streak', 'focus', 'next', 'otto']);
    expect(frozen).toEqual(ORDER);
  });
});

describe('visibleWidgets and restoreWidget', () => {
  it('keeps the saved order without the hidden ones', () => {
    expect(visibleWidgets(['otto', 'streak', 'next', 'focus'], ['next'])).toEqual([
      'otto',
      'streak',
      'focus',
    ]);
  });

  it('brings a hidden widget back after the visible ones, keeping a full order', () => {
    const restored = restoreWidget(['streak', 'next', 'focus', 'otto'], ['next', 'otto'], 'next');
    expect(restored).toEqual({
      widgetOrder: ['streak', 'focus', 'next', 'otto'],
      hiddenWidgets: ['otto'],
    });
  });
});

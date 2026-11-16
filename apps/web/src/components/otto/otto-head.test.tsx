// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OttoScene, OttoSceneOptions } from './otto-scene';

const LABEL = 'Otto, the KNOQRA assistant';

/** jsdom has no WebGL; each test decides whether the probe context exists. */
function stubWebGL(available: boolean) {
  const gl = { getExtension: () => ({ loseContext: () => {} }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => (available ? gl : null) as never,
  );
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (media: string) =>
      ({
        matches: reduce && media.includes('reduced-motion'),
        media,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

type MountOtto = (host: HTMLElement, opts: OttoSceneOptions) => OttoScene;

/** Loads OttoHead against a mocked scene module, so three.js never runs. */
async function renderHead(scene: () => { mountOtto: MountOtto }) {
  vi.resetModules();
  vi.doMock('./otto-scene', scene);
  const { OttoHead } = await import('./otto-head');
  return render(createElement(OttoHead, { mood: 'idle', size: 116 }));
}

/** The head is the still frame: an `<img>` that carries Otto's name itself. */
async function expectStill() {
  await waitFor(() => expect(screen.getByRole('img', { name: LABEL }).tagName).toBe('IMG'));
}

beforeEach(() => stubReducedMotion(false));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('./otto-scene');
});

describe('OttoHead', () => {
  it('shows the still image and never loads the scene without WebGL', async () => {
    stubWebGL(false);
    const mountOtto = vi.fn<MountOtto>();
    await renderHead(() => ({ mountOtto }));
    await expectStill();
    expect(mountOtto).not.toHaveBeenCalled();
  });

  it('shows the still image with reduced motion, even where WebGL works', async () => {
    stubWebGL(true);
    stubReducedMotion(true);
    const mountOtto = vi.fn<MountOtto>();
    await renderHead(() => ({ mountOtto }));
    await expectStill();
    expect(mountOtto).not.toHaveBeenCalled();
  });

  it('falls back to the still image when the scene chunk fails to load', async () => {
    stubWebGL(true);
    await renderHead(() => {
      throw new Error('chunk failed');
    });
    await expectStill();
  });

  it('falls back to the still image when the scene cannot start', async () => {
    stubWebGL(true);
    await renderHead(() => ({
      mountOtto: () => {
        throw new Error('no context');
      },
    }));
    await expectStill();
  });

  it('holds the place with an unnamed still until the scene mounts, then disposes it', async () => {
    stubWebGL(true);
    const dispose = vi.fn();
    const setMood = vi.fn();
    const mountOtto = vi.fn<MountOtto>(() => ({ setMood, dispose }));
    const view = await renderHead(() => ({ mountOtto }));

    const head = screen.getByRole('img', { name: LABEL });
    expect(head.tagName).toBe('SPAN');
    await waitFor(() => expect(mountOtto).toHaveBeenCalledTimes(1));
    expect(mountOtto.mock.calls[0]?.[1]).toMatchObject({ frame: 'head', still: false });
    expect(setMood).toHaveBeenCalledWith('idle');
    await waitFor(() => expect(head.querySelector('img')).toBeNull());

    view.unmount();
    expect(dispose).toHaveBeenCalled();
  });

  it('switches to the still image when the browser drops the WebGL context', async () => {
    stubWebGL(true);
    let lose: (() => void) | undefined;
    const mountOtto = vi.fn<MountOtto>((_host, opts) => {
      lose = opts.onContextLost;
      return { setMood: () => {}, dispose: () => {} };
    });
    await renderHead(() => ({ mountOtto }));
    await waitFor(() => expect(lose).toBeTypeOf('function'));
    act(() => lose?.());
    await expectStill();
  });
});

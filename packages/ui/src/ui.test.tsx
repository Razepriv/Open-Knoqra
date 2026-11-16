import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Avatar,
  Button,
  ButtonLink,
  Panel,
  Pill,
  Reveal,
  Skeleton,
  SkeletonAuth,
  SkeletonAvatar,
  SkeletonButton,
  SkeletonField,
  SkeletonPanel,
  SkeletonRow,
  SkeletonShell,
  SkeletonText,
  StatusDot,
  Toast,
} from './index';

afterEach(() => vi.useRealTimers());

describe('ui kit', () => {
  it('Avatar shows first+last initials', () => {
    render(<Avatar name="Maya Okafor Reyes" gradient="mint" />);
    expect(screen.getByText('MR')).toBeInTheDocument();
  });

  it('Avatar uses one letter for a single-word name', () => {
    render(<Avatar name="maya" gradient="peri" />);
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('Avatar ink tone is a solid dark disc from tokens, not a gradient', () => {
    render(<Avatar name="Ana Silva" tone="ink" size={42} />);
    const disc = screen.getByRole('img', { name: 'Ana Silva' });
    expect(disc.style.background).toBe('var(--mark-bg)');
    expect(disc.style.width).toBe('42px');
    expect(screen.getByText('AS')).toBeInTheDocument();
  });

  it('Pill exposes pressed state', () => {
    render(
      <Pill pressed onClick={() => {}}>
        Mute
      </Pill>,
    );
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Pill sm is 32px with 11px padding and 12px text, md stays 34px', () => {
    render(
      <>
        <Pill size="sm">All</Pill>
        <Pill>Mute</Pill>
      </>,
    );
    const sm = screen.getByRole('button', { name: 'All' }).className;
    expect(sm).toContain('h-8');
    expect(sm).toContain('px-[11px]');
    expect(sm).toContain('text-[12px]');
    expect(sm).not.toContain('h-[34px]');
    const md = screen.getByRole('button', { name: 'Mute' }).className;
    expect(md).toContain('h-[34px]');
    expect(md).not.toContain('h-8');
  });

  it('Pill is unpressed by default and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Pill onClick={onClick}>Hold</Pill>);
    const button = screen.getByRole('button', { name: 'Hold' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('disabled Button does not fire', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" disabled onClick={onClick}>
        Call
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Call' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Button merges className and defaults to type=button', () => {
    render(
      <Button variant="danger" className="extra">
        End
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'End' });
    expect(button).toHaveClass('extra');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('ButtonLink is a link that looks like the matching Button variant', () => {
    render(
      <>
        <Button variant="primary">Act</Button>
        <ButtonLink variant="primary" href="/contacts" className="extra">
          View
        </ButtonLink>
      </>,
    );
    const link = screen.getByRole('link', { name: 'View' });
    expect(link).toHaveAttribute('href', '/contacts');
    expect(link).toHaveClass('extra');
    expect(link.className).toContain('focus-visible:outline-[color:var(--line)]');
    const button = screen.getByRole('button', { name: 'Act' });
    for (const token of ['bg-[color:var(--accent)]', 'rounded-full', 'h-10']) {
      expect(link.className).toContain(token);
      expect(button.className).toContain(token);
    }
  });

  it('Button and Pill have a visible focus ring using --line', () => {
    render(
      <>
        <Button variant="primary">Go</Button>
        <Pill>Tag</Pill>
      </>,
    );
    for (const name of ['Go', 'Tag']) {
      const el = screen.getByRole('button', { name });
      expect(el.className).toContain('focus-visible:outline-2');
      expect(el.className).toContain('focus-visible:outline-offset-2');
      expect(el.className).toContain('focus-visible:outline-[color:var(--line)]');
    }
  });

  it('Panel renders children and merges className', () => {
    render(<Panel className="extra">Inside</Panel>);
    expect(screen.getByText('Inside')).toHaveClass('extra');
  });

  it('StatusDot has a text label', () => {
    render(<StatusDot status="warn" label="SMS paused" />);
    expect(screen.getByText('SMS paused')).toBeInTheDocument();
  });

  it('Button primary uses the accent shadow token', () => {
    render(<Button variant="primary">Go</Button>);
    const cls = screen.getByRole('button', { name: 'Go' }).className;
    expect(cls).toContain('var(--shadow-button)');
    expect(cls).toContain('var(--on-accent)');
    expect(cls).not.toContain('rgba(');
    expect(cls).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('Toast uses the toast shadow token and on-accent text', () => {
    render(<Toast message="Saved" onDone={() => {}} />);
    const cls = screen.getByRole('status').className;
    expect(cls).toContain('var(--shadow-toast)');
    expect(cls).toContain('var(--on-accent)');
    expect(cls).not.toContain('rgba(');
    expect(cls).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('Toast is a status region and calls onDone after the duration', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<Toast message="Saved" onDone={onDone} durationMs={1000} />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onDone).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('Skeleton announces a single loading status', () => {
    render(<Skeleton lines={3} />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('Skeleton accepts a custom label and variant', () => {
    render(<Skeleton variant="braille" lines={1} label="Loading contacts" />);
    expect(screen.getByRole('status', { name: 'Loading contacts' })).toBeInTheDocument();
  });

  it('Skeleton has screen-reader text equal to its label inside the status', () => {
    render(<Skeleton lines={1} label="Loading contacts" />);
    const status = screen.getByRole('status');
    expect(within(status).getByText('Loading contacts')).toHaveClass('sr-only');
  });

  it('Skeleton defaults its screen-reader text to Loading', () => {
    render(<Skeleton lines={1} />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  it('Skeleton with only a width and height draws one block of that size', () => {
    const { container } = render(<Skeleton width={72} height={12} label="Loading SMS" />);
    const block = container.querySelector('.ars-block') as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.style.width).toBe('72px');
    expect(block.style.height).toBe('12px');
    expect(container.querySelectorAll('.ars-line')).toHaveLength(0);
  });

  it('Skeleton clips its shimmer canvas to its own box', () => {
    render(<Skeleton lines={1} label="Loading row" />);
    expect(screen.getByRole('status', { name: 'Loading row' })).toHaveClass('overflow-hidden');
  });

  it('Skeleton hides its glyph layer from assistive tech', () => {
    const { container } = render(<Skeleton lines={2} />);
    expect(container.querySelector('[data-ascii-skeleton]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('Reveal keeps real children in the DOM for screen readers', () => {
    render(
      <Reveal loading={false}>
        <p>Maya Okafor</p>
      </Reveal>,
    );
    expect(screen.getByText('Maya Okafor')).toBeInTheDocument();
  });

  it('Reveal keeps the skeleton and the content swap readable while loading', () => {
    const { rerender } = render(
      <Reveal loading>
        <Skeleton lines={1} />
      </Reveal>,
    );
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    rerender(
      <Reveal loading={false}>
        <p>Maya Okafor</p>
      </Reveal>,
    );
    expect(screen.getByText('Maya Okafor')).toBeInTheDocument();
  });
});

describe('skeleton kit', () => {
  const statuses = () => document.querySelectorAll('[role="status"]');

  it('every part renders glyphs and announces nothing on its own', () => {
    const { container } = render(
      <>
        <SkeletonRow />
        <SkeletonRow avatar={false} lines={1} trailing="pill" />
        <SkeletonRow trailing="dot" />
        <SkeletonAvatar />
        <SkeletonButton />
        <SkeletonButton size="sm" width={90} />
        <SkeletonButton size="icon" />
        <SkeletonField />
        <SkeletonField label={false} width="60%" />
        <SkeletonText lines={3} widths={[80, 60, 40]} />
        <SkeletonText size="display" />
        <SkeletonPanel>
          <SkeletonText />
        </SkeletonPanel>
      </>,
    );
    expect(statuses()).toHaveLength(0);
    expect(container.querySelectorAll('[data-ascii-skeleton]').length).toBeGreaterThan(10);
  });

  it('SkeletonPanel exposes one status only when it has a label', () => {
    render(
      <SkeletonPanel label="Loading your contacts">
        <SkeletonRow />
        <SkeletonRow />
      </SkeletonPanel>,
    );
    expect(statuses()).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Loading your contacts' })).toBeInTheDocument();
  });

  it('SkeletonAvatar defaults to a 36px circle', () => {
    const { container } = render(<SkeletonAvatar />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root.style.width).toBe('36px');
    expect(root.style.height).toBe('36px');
  });

  it('SkeletonButton heights follow the button sizes', () => {
    const { container } = render(
      <>
        <SkeletonButton />
        <SkeletonButton size="sm" />
        <SkeletonButton size="icon" />
      </>,
    );
    const heights = Array.from(container.children).map((el) => (el as HTMLElement).style.height);
    expect(heights).toEqual(['40px', '32px', '42px']);
    expect((container.children[2] as HTMLElement).style.width).toBe('42px');
  });

  it('SkeletonField draws a label line and a 48px field outline', () => {
    const { container } = render(<SkeletonField />);
    expect(container.querySelectorAll('[data-skeleton-part="field-label"]')).toHaveLength(1);
    const outline = container.querySelector('[data-skeleton-part="field"]') as HTMLElement;
    expect(outline.className).toContain('h-12');
  });

  it('SkeletonText draws one glyph line per line', () => {
    const { container } = render(<SkeletonText lines={4} widths={[90, 70]} size="mono" />);
    expect(container.querySelectorAll('[data-skeleton-part="line"]')).toHaveLength(4);
  });

  it('SkeletonText centres its glyphs on full-width lines when asked', () => {
    const { container } = render(<SkeletonText lines={2} align="center" widths={['4rem']} />);
    const lines = container.querySelectorAll('[data-skeleton-part="line"]');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.className).toContain('justify-center');
  });

  it('SkeletonShell renders 6 rail circles, the top bar and one main', () => {
    const { container } = render(
      <SkeletonShell railItems={6}>
        <SkeletonText />
      </SkeletonShell>,
    );
    expect(container.querySelectorAll('[data-skeleton-part="rail-circle"]')).toHaveLength(6);
    expect(container.querySelectorAll('[data-skeleton-part="top-bar"]')).toHaveLength(1);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelectorAll('[data-skeleton-part="ribbon"]')).toHaveLength(0);
    expect(statuses()).toHaveLength(0);
  });

  it('SkeletonShell defaults to the Desk rail: six pages plus Settings', () => {
    const { container } = render(<SkeletonShell />);
    expect(container.querySelectorAll('[data-skeleton-part="rail-circle"]')).toHaveLength(7);
  });

  it('SkeletonShell adds the ribbon column when asked', () => {
    const { container } = render(<SkeletonShell ribbon />);
    expect(container.querySelectorAll('[data-skeleton-part="ribbon"]')).toHaveLength(1);
  });

  it('SkeletonAuth with fields: 3 renders 3 field outlines and 1 button', () => {
    const { container } = render(<SkeletonAuth fields={3} />);
    expect(container.querySelectorAll('[data-skeleton-part="field"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-skeleton-part="button"]')).toHaveLength(1);
    expect(container.querySelectorAll('main')).toHaveLength(1);
  });

  it('SkeletonShell and SkeletonAuth pass a label and data attributes through', () => {
    render(
      <>
        <SkeletonShell data-skeleton="shell" />
        <SkeletonAuth fields={2} label="Loading sign in" data-skeleton="sign-in" />
      </>,
    );
    expect(statuses()).toHaveLength(1);
    expect(document.querySelector('[data-skeleton="shell"]')).not.toBeNull();
    expect(screen.getByRole('status', { name: 'Loading sign in' })).toBeInTheDocument();
  });

  it('Skeleton decorative has no status and hides itself', () => {
    const { container } = render(<Skeleton decorative rows={1} width={40} height={12} />);
    expect(statuses()).toHaveLength(0);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

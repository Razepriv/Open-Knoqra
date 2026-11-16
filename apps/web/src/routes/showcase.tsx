import type { dot, gradients } from '@knoqra/tokens';
import { Avatar, Button, Panel, Pill, Reveal, Skeleton, StatusDot, Toast } from '@knoqra/ui';
import { createFileRoute } from '@tanstack/react-router';
import { Inbox, Phone, Star } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Brand } from '../components/brand';
import { ThemeToggle } from '../components/theme-toggle';
import { useToast } from '../components/use-toast';

/** Public reference page: every @knoqra/ui component in each state. Flip the theme for dark. */
export const Route = createFileRoute('/showcase')({
  component: Showcase,
});

const avatarSamples: ReadonlyArray<{ name: string; gradient: keyof typeof gradients }> = [
  { name: 'Ana Silva', gradient: 'mint' },
  { name: 'Mei Chen', gradient: 'apr' },
  { name: 'Tomás Ruiz', gradient: 'peri' },
  { name: 'Priya Nair', gradient: 'cit' },
  { name: 'Jonas Berg', gradient: 'grey' },
  { name: 'Leah Okafor', gradient: 'red' },
  { name: 'Sam Doyle', gradient: 'amber' },
  { name: 'Iris Kato', gradient: 'hl' },
];

const statusSamples: ReadonlyArray<{ status: keyof typeof dot; label: string }> = [
  { status: 'ok', label: 'Voice connected' },
  { status: 'warn', label: 'SMS in carrier review' },
  { status: 'bad', label: 'WhatsApp rejected' },
  { status: 'none', label: 'No number yet' },
];

function Showcase() {
  return (
    <>
      <header className="flex h-[66px] items-center gap-3 rounded-[26px] border border-[color:var(--panelBorder)] bg-[image:var(--panel)] px-[10px] [box-shadow:var(--panelShadow)]">
        <Brand />
        <span className="flex-1" />
        <span className="hidden font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase tracking-[.04em] sm:inline">
          Light and dark · flip with the toggle
        </span>
        <ThemeToggle />
      </header>
      <main className="flex flex-col gap-4">
        <Panel className="flex flex-col gap-3 p-6 sm:p-9">
          <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]">
            @knoqra/ui
          </p>
          <h1 className="font-[family-name:var(--font-display)] text-[clamp(36px,5vw,56px)] leading-none tracking-[-0.03em]">
            Component kit
          </h1>
          <p className="max-w-[60ch] text-[15px] text-[color:var(--muted)]">
            Every shared component in each of its states. The page itself is built from Panels.
          </p>
        </Panel>
        <div className="grid gap-4 lg:grid-cols-2">
          <ButtonSection />
          <PillSection />
          <AvatarSection />
          <StatusSection />
          <ToastSection />
          <PanelSection />
          <LoadingSection />
        </div>
      </main>
    </>
  );
}

function Section({ title, meta, children }: { title: string; meta: string; children: ReactNode }) {
  return (
    <Panel className="flex flex-col gap-5 p-6">
      <div className="flex items-baseline gap-3">
        <h2 className="font-[family-name:var(--font-display)] text-[24px] leading-none tracking-[-0.025em]">
          {title}
        </h2>
        <span className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase tracking-[.04em]">
          {meta}
        </span>
      </div>
      {children}
    </Panel>
  );
}

/** Sample controls answer with a toast, so pressing one visibly does something. */
function ButtonSection() {
  const { show, toast } = useToast();
  return (
    <Section title="Button" meta="primary · danger · ghost · disabled">
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" onClick={() => show('Primary pressed')}>
          <Phone size={16} aria-hidden="true" />
          Primary
        </Button>
        <Button variant="danger" onClick={() => show('Danger pressed')}>
          Danger
        </Button>
        <Button variant="ghost" onClick={() => show('Ghost pressed')}>
          Ghost
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" disabled>
          Primary disabled
        </Button>
        <Button variant="danger" disabled>
          Danger disabled
        </Button>
        <Button variant="ghost" disabled>
          Ghost disabled
        </Button>
      </div>
      {toast}
    </Section>
  );
}

function PillSection() {
  const [unread, setUnread] = useState(true);
  const { show, toast } = useToast();
  return (
    <Section title="Pill" meta="default · pressed · toggle">
      <div className="flex flex-wrap gap-3">
        <Pill onClick={() => show('All pressed')}>All</Pill>
        <Pill pressed>Pressed</Pill>
        <Pill pressed={unread} onClick={() => setUnread((value) => !value)}>
          <Inbox size={14} aria-hidden="true" />
          Unread only
        </Pill>
        <Pill disabled>
          <Star size={14} aria-hidden="true" />
          Disabled
        </Pill>
      </div>
      {toast}
    </Section>
  );
}

function AvatarSection() {
  return (
    <Section title="Avatar" meta="every gradient · three sizes">
      <div className="flex flex-wrap items-center gap-3">
        {avatarSamples.map((sample) => (
          <Avatar key={sample.gradient} name={sample.name} gradient={sample.gradient} />
        ))}
      </div>
      <div className="flex items-end gap-3">
        <Avatar name="Ana Silva" gradient="mint" size={28} />
        <Avatar name="Ana Silva" gradient="mint" size={36} />
        <Avatar name="Ana Silva" gradient="mint" size={56} />
      </div>
    </Section>
  );
}

function StatusSection() {
  return (
    <Section title="StatusDot" meta="ok · warn · bad · none">
      <div className="flex flex-col gap-3">
        {statusSamples.map((sample) => (
          <StatusDot key={sample.status} status={sample.status} label={sample.label} />
        ))}
      </div>
    </Section>
  );
}

function ToastSection() {
  const [shown, setShown] = useState(1);
  return (
    <Section title="Toast" meta="auto-dismisses after 3.6 s">
      <div className="flex min-h-[46px] flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={() => setShown((n) => n + 1)}>
          Show toast
        </Button>
        {shown > 0 ? (
          <Toast key={shown} message="Note saved to Ana's timeline" onDone={() => setShown(0)} />
        ) : null}
      </div>
    </Section>
  );
}

function PanelSection() {
  return (
    <Section title="Panel" meta="radius 30 · panel gradient · soft shadow">
      <div className="grid grid-cols-2 gap-3">
        <Panel className="p-4 text-[14px]">A panel inside a panel.</Panel>
        <div className="rounded-[18px] bg-[color:var(--cell)] p-4 text-[14px] text-[color:var(--muted)] [box-shadow:var(--cellShadow)]">
          A sunken cell.
        </div>
      </div>
    </Section>
  );
}

const skeletonVariants = ['dither', 'scan', 'braille', 'terminal'] as const;

function LoadingSection() {
  const [loading, setLoading] = useState(true);
  return (
    <Section title="Loading states" meta="Skeleton · Reveal · ascii-reveal">
      <div className="grid grid-cols-2 gap-4">
        {skeletonVariants.map((variant) => (
          <div key={variant} className="flex flex-col gap-2">
            <span className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase tracking-[.04em]">
              {variant}
            </span>
            <Skeleton variant={variant} lines={3} label={`Loading ${variant} sample`} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <Skeleton circle rows={4} width={56} height={56} label="Loading avatar" />
        <div className="flex-1">
          <Skeleton lines={2} widths={[70, 40]} animate={false} label="Loading static sample" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Button variant="ghost" onClick={() => setLoading((value) => !value)}>
          {loading ? 'Finish loading' : 'Load again'}
        </Button>
        <Reveal loading={loading}>
          {loading ? (
            <Skeleton lines={2} widths={[55, 30]} label="Loading sample contact" />
          ) : (
            <div className="flex items-center gap-3 rounded-[18px] bg-[color:var(--cell)] p-4 [box-shadow:var(--cellShadow)]">
              <Avatar name="Maya Okafor" gradient="peri" />
              <div className="flex flex-col gap-1">
                <p className="font-medium text-[15px]">Maya Okafor</p>
                <p className="text-[13px] text-[color:var(--muted)]">Last spoke yesterday</p>
              </div>
            </div>
          )}
        </Reveal>
      </div>
    </Section>
  );
}

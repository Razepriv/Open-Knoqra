import { authLayout, Panel } from '@knoqra/ui';
import { MessageCircle, MessageSquareText, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { Brand } from './brand';
import { PoweredBy } from './powered-by';
import { ThemeToggle } from './theme-toggle';

export interface AuthLayoutProps {
  /** Big Space Grotesk line on the intro panel. */
  headline: string;
  lede: string;
  /** Mono caps label above the form title (CSS renders the caps). */
  eyebrow: string;
  title: string;
  children: ReactNode;
  footer: ReactNode;
}

const channels = [
  { icon: Phone, label: 'Calls' },
  { icon: MessageSquareText, label: 'SMS' },
  { icon: MessageCircle, label: 'WhatsApp' },
] as const;

/** Two panels on the shell: the promise on the left, the form on the right. */
export function AuthLayout({ headline, lede, eyebrow, title, children, footer }: AuthLayoutProps) {
  return (
    <main className={authLayout.grid}>
      <Panel className={authLayout.hero}>
        <div className={authLayout.heroTop}>
          <Brand />
          <ThemeToggle />
        </div>
        <div className={authLayout.heroCopy}>
          <h1 className="max-w-[14ch] font-[family-name:var(--font-display)] text-[clamp(40px,5.6vw,72px)] leading-[0.98] tracking-[-0.035em]">
            {headline}
          </h1>
          <p className="max-w-[42ch] text-[16px] text-[color:var(--muted)] leading-relaxed">
            {lede}
          </p>
          <ul className="flex flex-wrap gap-2" aria-label="Channels">
            {channels.map(({ icon: Icon, label }) => (
              <li
                key={label}
                className="inline-flex h-[34px] items-center gap-2 rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 font-medium text-[13px] [box-shadow:var(--pillShadow)]"
              >
                <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-24 -z-10 size-72 rounded-full bg-[image:var(--grad-hl)] opacity-40 blur-3xl"
        />
      </Panel>

      <Panel className={authLayout.formPanel}>
        <div className={authLayout.formColumn}>
          <div className={authLayout.formHeading}>
            <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]">
              {eyebrow}
            </p>
            <h2 className="font-[family-name:var(--font-display)] text-[30px] leading-none tracking-[-0.025em]">
              {title}
            </h2>
          </div>
          {children}
          <p className="text-[14px] text-[color:var(--muted)]">{footer}</p>
          {/* Required by ADDITIONAL-TERMS.md (AGPL section 7(b)): keep it visible. */}
          <PoweredBy />
        </div>
      </Panel>
    </main>
  );
}

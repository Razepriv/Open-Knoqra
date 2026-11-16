import { Panel } from '@knoqra/ui';
import { type CapabilityTile, capabilityTiles, type PhoneNumber } from '../../lib/numbers';
import type { Setup } from '../../lib/setup';
import { sectionHeading } from '../usage/usage-layout';
import { TILE_HEIGHT } from './numbers-skeletons';

function Tile({ tile }: { tile: CapabilityTile }) {
  return (
    <li
      data-ready={tile.ready}
      className={`${TILE_HEIGHT} flex flex-col gap-1 rounded-[20px] bg-[color:var(--cell)] p-4`}
    >
      <p className="font-medium text-[15px]">{tile.label}</p>
      <p className="font-[family-name:var(--font-mono)] font-medium text-[12px] uppercase tracking-[.04em]">
        {tile.ready ? 'Ready' : 'Not ready'}
      </p>
      <p className="text-[13px] text-[color:var(--muted)] leading-snug">{tile.reason}</p>
    </li>
  );
}

export function CapabilityTiles({
  setup,
  numbers,
}: {
  setup: Setup;
  numbers: readonly PhoneNumber[];
}) {
  return (
    <section aria-labelledby="capabilities-heading">
      <Panel className="flex flex-col gap-4 p-5 sm:p-6">
        <h2 id="capabilities-heading" className={sectionHeading}>
          Capabilities
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {capabilityTiles(setup.checks, numbers).map((tile) => (
            <Tile key={tile.id} tile={tile} />
          ))}
        </ul>
      </Panel>
    </section>
  );
}

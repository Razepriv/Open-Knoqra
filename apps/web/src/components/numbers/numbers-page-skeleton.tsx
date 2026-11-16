import { Panel, Skeleton } from '@knoqra/ui';
import {
  CapabilityTilesSkeleton,
  NumberListSkeleton,
  SetupChecksSkeleton,
} from './numbers-skeletons';

/** The whole Numbers page as a placeholder: header, checks, capability tiles and number rows. */
export function NumbersPageSkeleton() {
  return (
    <section className="flex flex-1 flex-col gap-4" aria-label="Loading numbers">
      <Panel className="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6">
        <Skeleton lines={1} widths={[20]} height={34} label="Loading numbers title" />
        <Skeleton height={34} width={130} label="Loading setup link" />
      </Panel>
      <SetupChecksSkeleton />
      <CapabilityTilesSkeleton />
      <NumberListSkeleton />
    </section>
  );
}

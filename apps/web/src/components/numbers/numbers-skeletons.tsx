import { Panel, Skeleton } from '@knoqra/ui';

/**
 * The Numbers page's loading shapes and the layout constants its real panels share with them. A
 * leaf module: the page outline loads with the route tree, so nothing here loads data.
 */

/** A capability tile's height, loaded or not. */
export const TILE_HEIGHT = 'min-h-[112px]';
/** A setup check row's height, loaded or not. */
export const CHECK_ROW_HEIGHT = 'min-h-[76px]';
/** The number table's columns. */
export const NUMBER_HEADERS = [
  'Number',
  'Capabilities',
  'Status',
  '10DLC',
  'WhatsApp',
  'Assigned use',
];

const GRID =
  'grid grid-cols-[minmax(130px,1.1fr)_minmax(140px,1.4fr)_90px_120px_110px_minmax(170px,1.2fr)] items-center gap-4';

export function CapabilityTilesSkeleton() {
  return (
    <Panel className="flex flex-col gap-4 p-5 sm:p-6">
      <Skeleton lines={1} widths={[25]} height={22} label="Loading capabilities heading" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {['voice', 'sms', 'mms', 'whatsapp'].map((id) => (
          <div key={id} className={`${TILE_HEIGHT} rounded-[20px] bg-[color:var(--cell)] p-4`}>
            <Skeleton lines={3} widths={[40, 30, 85]} label="Loading capability" />
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** The rows' footprint, used while the checks load. */
export function SetupChecksSkeleton() {
  return (
    <Panel className="flex flex-col gap-4 p-5 sm:p-6">
      <Skeleton lines={1} widths={[30]} height={22} label="Loading setup checks heading" />
      {['one', 'two', 'three', 'four', 'five', 'six'].map((id) => (
        <div
          key={id}
          className={`${CHECK_ROW_HEIGHT} flex items-center gap-4 rounded-[20px] bg-[color:var(--cell)] p-4`}
        >
          <Skeleton height={16} width={80} label="Loading check status" />
          <Skeleton lines={2} widths={[35, 70]} label="Loading check" className="flex-1" />
          <Skeleton height={34} width={90} label="Loading check action" />
        </div>
      ))}
    </Panel>
  );
}

/** Positioned, so the rows' absolutely placed screen-reader labels scroll with the table. */
export function NumberListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Panel className="relative overflow-x-auto p-5 sm:p-6">
      <div className="flex min-w-[820px] flex-col gap-5" aria-busy="true">
        <Skeleton height={40} width={150} label="Loading numbers heading" />
        <div className="flex flex-col gap-2">
          <div aria-hidden="true" className={`${GRID} px-3 pb-1`}>
            {NUMBER_HEADERS.map((header) => (
              <Skeleton key={header} height={11} width={60} label="Loading column" />
            ))}
          </div>
          {Array.from({ length: rows }, (_, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
              key={index}
              aria-hidden={index > 0 ? true : undefined}
              className={`${GRID} h-[64px] rounded-[20px] bg-[color:var(--cell)] px-3`}
            >
              <Skeleton lines={1} widths={[80]} label="Loading number" />
              <Skeleton height={28} width={130} label="Loading capabilities" />
              <Skeleton lines={1} widths={[60]} label="Loading" />
              <Skeleton lines={1} widths={[70]} label="Loading" />
              <Skeleton lines={1} widths={[60]} label="Loading" />
              <Skeleton height={40} width={170} label="Loading assignment" />
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

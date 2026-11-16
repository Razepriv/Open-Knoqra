import { Panel, Skeleton } from '@knoqra/ui';

/** A labelled input's footprint: the label line over a 48 px cell, like `Field`. */
function FieldSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton lines={1} widths={[30]} label={`${label} label`} />
      <Skeleton height={48} label={label} className="w-full rounded-2xl" />
    </div>
  );
}

/** The stepper's footprint: four step pills in a row. */
export function StepperSkeleton() {
  return (
    <div aria-hidden="true" className="grid gap-2 sm:grid-cols-4">
      {['one', 'two', 'three', 'four'].map((id) => (
        <Skeleton key={id} height={52} label="Loading setup steps" className="w-full" />
      ))}
    </div>
  );
}

export function ConnectStepSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <FieldSkeleton label="Loading first field" />
      <FieldSkeleton label="Loading second field" />
      <FieldSkeleton label="Loading third field" />
      <Skeleton lines={1} widths={[60]} label="Loading key storage note" />
      <Skeleton height={40} width={160} label="Loading save button" />
    </div>
  );
}

export function NumberStepSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton height={40} width={170} label="Loading sync button" />
      {['one', 'two', 'three'].map((id) => (
        <div key={id} className="flex items-center gap-3">
          <Skeleton circle width={18} height={18} label="Loading number choice" />
          <Skeleton lines={1} widths={[28]} label="Loading number" className="w-40" />
          <Skeleton height={28} width={150} label="Loading capabilities" />
        </div>
      ))}
      <Skeleton height={40} width={230} label="Loading assign button" />
    </div>
  );
}

/** The whole `/setup` page while its progress loads: header, stepper and a step card. */
export function SetupPageSkeleton() {
  return (
    <section className="flex flex-1 flex-col gap-4" aria-label="Loading setup">
      <Panel className="flex flex-col gap-4 p-6 sm:p-9">
        <Skeleton lines={1} widths={[12]} label="Loading setup eyebrow" />
        <Skeleton lines={1} widths={[34]} height={52} label="Loading setup title" />
        <Skeleton lines={2} widths={[70, 45]} label="Loading setup intro" />
      </Panel>
      <StepperSkeleton />
      <Panel className="flex flex-col gap-6 p-6 sm:p-8">
        <Skeleton lines={2} widths={[32, 60]} label="Loading step heading" />
        <ConnectStepSkeleton />
      </Panel>
    </section>
  );
}

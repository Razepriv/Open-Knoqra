import { Button } from '@knoqra/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isUnauthorized } from '../../lib/api';
import { duplicatesRoot, timelineRoot } from '../../lib/contact360-queries';
import { contactRoot, contactsKey } from '../../lib/contacts';
import { type ColumnMapping, guessMapping, type ParsedCsv, toImportRows } from '../../lib/csv';
import { haptic } from '../../lib/haptics';
import { importHaptic } from '../../lib/import-haptic';
import {
  type DuplicateMode,
  failedSummary,
  type ImportProgress,
  type ImportSummary,
  postImportBatch,
  runImport,
  shouldBlockImportExit,
} from '../../lib/import-runner';
import { DialogShell } from '../dialog-shell';
import { MapStep } from './map-step';
import { ResultsStep } from './results-step';
import { ReviewStep } from './review-step';
import { RunStep } from './run-step';
import { UploadStep } from './upload-step';

type Step = 'upload' | 'map' | 'review' | 'run' | 'results';

interface LoadedFile extends ParsedCsv {
  name: string;
}

export interface ImportWizardProps {
  contactsHref: string;
}

/** Stops a file dropped outside the dropzone from making the browser open it and leave the page. */
function useIgnoreStrayDrops() {
  useEffect(() => {
    const ignore = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', ignore);
    window.addEventListener('drop', ignore);
    return () => {
      window.removeEventListener('dragover', ignore);
      window.removeEventListener('drop', ignore);
    };
  }, []);
}

export function ImportWizard({ contactsHref }: ImportWizardProps) {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [onDuplicate, setOnDuplicate] = useState<DuplicateMode>('skip');
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const controller = useRef<AbortController | null>(null);
  // Set when the run ended on a 401: the app is about to go to sign-in, which must not be blocked.
  const sessionEnded = useRef(false);
  // What the run had confirmed when it threw, so an error can still show the partial results.
  const partial = useRef<ImportSummary | null>(null);
  // Heading focus follows step changes, not the first paint of the page.
  const stepChanges = useRef(0);

  const queryClient = useQueryClient();

  useIgnoreStrayDrops();

  function goTo(next: Step) {
    stepChanges.current += 1;
    setStep(next);
  }

  const importRows = useMemo(() => (file ? toImportRows(file.rows, mapping) : []), [file, mapping]);

  const run = useMutation({
    mutationFn: async (loaded: LoadedFile): Promise<ImportSummary> => {
      const abort = new AbortController();
      controller.current = abort;
      partial.current = null;
      sessionEnded.current = false;
      const result = await runImport({
        rows: importRows,
        fileName: loaded.name,
        onDuplicate,
        importBatch: postImportBatch,
        signal: abort.signal,
        onProgress: setProgress,
        rowNumbers: loaded.rowNumbers,
      });
      // A 401 means the session ended: throw it so the app's global handler sends the user to
      // sign-in. The partial results are kept for the results step below.
      if (result.status === 'failed' && isUnauthorized(result.error)) {
        partial.current = result;
        sessionEnded.current = true;
        throw result.error;
      }
      return result;
    },
    onSuccess: (result) => {
      // Only a finished run is "done". A failed one feels like the failure it is; a cancelled one
      // was the person's own choice and stays silent.
      const pattern = importHaptic(result.status);
      if (pattern) haptic(pattern);
      setSummary(result);
      goTo('results');
    },
    // Partial and cancelled runs created contacts too, so every way out of the run refreshes what
    // earlier pages cached: the list, each contact, its duplicates and its timeline.
    onSettled: () =>
      Promise.all(
        [contactsKey, contactRoot, duplicatesRoot, timelineRoot].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
    // Whatever went wrong, leave the run step: show what was confirmed plus an error.
    onError: (error) => {
      haptic('error');
      setSummary(partial.current ?? failedSummary(error, importRows.length));
      goTo('results');
    },
  });

  // In-app navigation during the run (rail, account menu, Back) would unmount the wizard and stop
  // the import, so ask first. A reload is covered by the beforeunload guard below. Sign-out goes
  // through: its session is already gone when it navigates.
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => shouldBlockImportExit(sessionEnded.current, next.pathname),
    disabled: step !== 'run',
    enableBeforeUnload: false,
    withResolver: true,
  });
  const blocked = blocker.status === 'blocked';
  const resetBlocker = blocker.reset;
  // The run can finish while the question is open: nothing is left to stop.
  useEffect(() => {
    if (step !== 'run' && blocked) resetBlocker?.();
  }, [step, blocked, resetBlocker]);

  // Leaving the page stops the import before its next batch.
  useEffect(() => () => controller.current?.abort(), []);

  // A running import would be lost to a reload, so ask first.
  useEffect(() => {
    if (step !== 'run') return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [step]);

  function startImport() {
    if (!file || run.isPending) return;
    setCancelling(false);
    setProgress({ batch: 0, batches: 1, processed: 0, total: importRows.length });
    goTo('run');
    run.mutate(file);
  }

  function startOver() {
    run.reset();
    setFile(null);
    setMapping({});
    setOnDuplicate('skip');
    setProgress(null);
    setSummary(null);
    setCancelling(false);
    goTo('upload');
  }

  return (
    <div className="flex flex-col gap-4">
      <DialogShell
        open={blocked && step === 'run'}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title="Leave and stop the import?"
        description="Rows already sent stay imported."
        size="sm"
        initialFocusId="keep-importing"
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              controller.current?.abort();
              blocker.proceed?.();
            }}
          >
            Stop and leave
          </Button>
          <Button variant="primary" id="keep-importing" onClick={() => blocker.reset?.()}>
            Keep importing
          </Button>
        </div>
      </DialogShell>
      <StepList current={step} />
      {step === 'upload' ? (
        <UploadStep
          focusHeading={stepChanges.current > 0}
          onParsed={(name, parsed) => {
            setFile({ name, ...parsed });
            setMapping(guessMapping(parsed.headers));
            goTo('map');
          }}
        />
      ) : null}
      {step === 'map' && file ? (
        <MapStep
          fileName={file.name}
          headers={file.headers}
          rows={file.rows}
          warnings={file.warnings}
          mapping={mapping}
          onMappingChange={setMapping}
          onBack={startOver}
          onContinue={() => goTo('review')}
        />
      ) : null}
      {step === 'review' && file ? (
        <ReviewStep
          rows={importRows}
          rowNumbers={file.rowNumbers}
          mapping={mapping}
          onDuplicate={onDuplicate}
          onDuplicateChange={setOnDuplicate}
          onBack={() => goTo('map')}
          onImport={startImport}
        />
      ) : null}
      {step === 'run' && progress ? (
        <RunStep
          progress={progress}
          cancelling={cancelling}
          onCancel={() => {
            setCancelling(true);
            controller.current?.abort();
          }}
        />
      ) : null}
      {step === 'results' && file && summary ? (
        <ResultsStep
          summary={summary}
          fileName={file.name}
          headers={file.headers}
          rows={file.rows}
          importRows={importRows}
          onStartOver={startOver}
          contactsHref={contactsHref}
        />
      ) : null}
    </div>
  );
}

const STEPS: readonly { id: Step; label: string }[] = [
  { id: 'upload', label: 'Upload' },
  { id: 'map', label: 'Map' },
  { id: 'review', label: 'Review' },
  { id: 'run', label: 'Import' },
  { id: 'results', label: 'Results' },
];

function StepList({ current }: { current: Step }) {
  const currentIndex = STEPS.findIndex((item) => item.id === current);
  return (
    <ol
      aria-label="Import progress steps"
      className="m-0 flex list-none flex-wrap gap-2 p-0 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[.04em]"
    >
      {STEPS.map((item, index) => {
        const active = index === currentIndex;
        return (
          <li
            key={item.id}
            aria-current={active ? 'step' : undefined}
            className={`rounded-full border px-3 py-[7px] leading-none ${
              active
                ? 'border-[color:var(--pillBorder)] bg-[color:var(--pressed)] text-[color:var(--text)] [box-shadow:var(--pressedShadow)]'
                : index < currentIndex
                  ? 'border-[color:var(--pillBorder)] bg-[color:var(--pill)] text-[color:var(--text)] [box-shadow:var(--pillShadow)]'
                  : 'border-transparent text-[color:var(--muted)]'
            }`}
          >
            {index + 1} · {item.label}
          </li>
        );
      })}
    </ol>
  );
}

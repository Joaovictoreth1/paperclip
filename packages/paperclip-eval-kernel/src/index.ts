export type MaybePromise<T> = T | PromiseLike<T>;

export const PAPERCLIP_EVAL_KERNEL_COMPATIBILITY = Object.freeze({
  schema: "paperclip.eval-kernel.compatibility.v1",
  packageName: "@paperclipai/paperclip-eval-kernel",
  packageVersion: "0.1.0",
  apiVersion: 1,
} as const);

export type PaperclipEvalKernelCompatibility = typeof PAPERCLIP_EVAL_KERNEL_COMPATIBILITY;

export interface PaperclipEvalScenario<TInput = unknown> {
  readonly id: string;
  readonly input: TInput;
}

export interface PaperclipEvalCandidate<TCandidate = unknown> {
  readonly id: string;
  readonly config: TCandidate;
  /** Fail-closed runner/catalog/provider compatibility check. */
  readonly preflight?: () => MaybePromise<void>;
}

export interface PaperclipEvalResult<TOutput = unknown, TScore = unknown> {
  readonly scenarioId: string;
  readonly candidateId: string;
  readonly output: TOutput;
  readonly score: TScore;
}

export interface PaperclipEvalExecuteContext<TInput = unknown, TCandidate = unknown> {
  readonly scenario: PaperclipEvalScenario<TInput>;
  readonly candidate: PaperclipEvalCandidate<TCandidate>;
}

export interface PaperclipEvalScoreContext<
  TInput = unknown,
  TCandidate = unknown,
  TOutput = unknown,
> extends PaperclipEvalExecuteContext<TInput, TCandidate> {
  readonly output: TOutput;
}

export interface PaperclipEvalMatrixOptions<
  TInput = unknown,
  TCandidate = unknown,
  TOutput = unknown,
  TScore = unknown,
> {
  readonly scenarios: readonly PaperclipEvalScenario<TInput>[];
  readonly candidates: readonly PaperclipEvalCandidate<TCandidate>[];
  readonly execute: (
    context: PaperclipEvalExecuteContext<TInput, TCandidate>,
  ) => MaybePromise<TOutput>;
  readonly score: (
    context: PaperclipEvalScoreContext<TInput, TCandidate, TOutput>,
  ) => MaybePromise<TScore>;
  readonly signal?: AbortSignal;
}

export type PaperclipEvalEntityKind = "scenario" | "candidate";

export class PaperclipEvalKernelConfigurationError extends Error {
  readonly code = "paperclip_eval_kernel_configuration_invalid" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * Generic deterministic matrix orchestration. Scenario definitions, provider
 * configuration, scorers, reports, and persistence remain caller-owned.
 */
export async function runPaperclipEvalMatrix<
  TInput,
  TCandidate,
  TOutput,
  TScore,
>(
  input: PaperclipEvalMatrixOptions<TInput, TCandidate, TOutput, TScore>,
): Promise<readonly Readonly<PaperclipEvalResult<TOutput, TScore>>[]> {
  const { scenarios, candidates, execute, score, signal } = input;

  assertUniqueNonEmptyIds("scenario", scenarios);
  assertUniqueNonEmptyIds("candidate", candidates);

  for (const candidate of candidates) {
    signal?.throwIfAborted();
    await candidate.preflight?.();
  }

  const results: Readonly<PaperclipEvalResult<TOutput, TScore>>[] = [];

  for (const scenario of scenarios) {
    for (const candidate of candidates) {
      signal?.throwIfAborted();

      const executeContext = Object.freeze({ scenario, candidate });
      const output = await execute(executeContext);

      signal?.throwIfAborted();

      const scoreContext = Object.freeze({ scenario, candidate, output });
      const evaluatedScore = await score(scoreContext);

      results.push(
        Object.freeze({
          scenarioId: scenario.id,
          candidateId: candidate.id,
          output,
          score: evaluatedScore,
        }),
      );
    }
  }

  return Object.freeze(results);
}

function assertUniqueNonEmptyIds(
  kind: PaperclipEvalEntityKind,
  values: readonly { readonly id: string }[],
): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new PaperclipEvalKernelConfigurationError(`${kind} list must not be empty`);
  }

  const seenIds = new Set<string>();

  for (const value of values) {
    const id = typeof value?.id === "string" ? value.id : "";

    if (id.trim().length === 0) {
      throw new PaperclipEvalKernelConfigurationError(`${kind} id must not be empty`);
    }

    if (seenIds.has(id)) {
      throw new PaperclipEvalKernelConfigurationError(`duplicate ${kind} id: ${id}`);
    }

    seenIds.add(id);
  }
}

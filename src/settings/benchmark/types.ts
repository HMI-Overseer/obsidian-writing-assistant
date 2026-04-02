export interface BenchmarkTestCase {
  id: string;
  name: string;
  description: string;
  /** Document content injected into the system prompt. */
  document: string;
  /** Appended to the model's base system prompt (edit instructions, annotation rule, etc.). */
  systemPromptSuffix: string;
  /** Synthetic conversation history leading up to the model's response. */
  messages: BenchmarkMessage[];
  /** Evaluates the model's response and returns a pass/fail result. */
  evaluate: (response: string, testCase: BenchmarkTestCase) => BenchmarkResult;
  /** If true, this test is a control — expected to fail or be unreliable. */
  isControl?: boolean;
}

export interface BenchmarkMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BenchmarkResult {
  passed: boolean;
  reason: string;
  /** Relevant snippets extracted from the model's response as evidence. */
  evidence: string[];
}

/** Result of a single iteration of a single test. */
export interface BenchmarkIterationResult {
  iteration: number;
  result: BenchmarkResult;
  rawResponse: string;
  durationMs: number;
}

/** Aggregate result for a test case across all iterations. */
export interface BenchmarkRunResult {
  testId: string;
  testName: string;
  modelId: string;
  iterations: BenchmarkIterationResult[];
  /** Number of iterations that passed. */
  passCount: number;
  /** Total iterations run. */
  totalCount: number;
  /** Average duration across all iterations. */
  avgDurationMs: number;
}

export interface BenchmarkTestSuite {
  id: string;
  /** Tab label (e.g., "Edit annotations"). */
  name: string;
  /** Shown below tabs when the suite is active. */
  description: string;
  /** Optional Obsidian icon name for the tab. */
  icon?: string;
  testCases: BenchmarkTestCase[];
}

export type TestRunState = "idle" | "running" | "done" | "error";

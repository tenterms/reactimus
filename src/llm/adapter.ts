import type {
  GroupScores,
  InputUrlRow,
  PageContentRow,
  QueryGroup,
  SuggestedEditRow,
  ToolConfig,
} from '../types.js';

/**
 * Optional LLM layer. The pipeline is fully functional without it — the
 * heuristic scores always run first, and an adapter (when configured) may
 * refine them. The noop adapter keeps everything deterministic.
 */
export interface LlmScoreReview {
  topicalRelevance?: number;
  intentMatch?: number;
  commerciality?: number;
  distinctTopic?: number;
  cannibalisationRisk?: number;
  rationale?: string;
}

export interface LlmAdapter {
  readonly name: string;
  reviewScores(input: {
    group: QueryGroup;
    heuristicScores: GroupScores;
    page: PageContentRow;
    inputMeta?: InputUrlRow;
    config: ToolConfig;
  }): Promise<LlmScoreReview | null>;
  /**
   * Optionally rewrite a Suggested Edit's template copy into publishable
   * draft copy, grounded strictly in the fetched page content (no invented
   * claims). Return null to keep the heuristic template.
   */
  draftEdit?(input: {
    edit: SuggestedEditRow;
    page?: PageContentRow;
    config: ToolConfig;
  }): Promise<string | null>;
}

export class NoopLlmAdapter implements LlmAdapter {
  readonly name = 'none';
  async reviewScores(): Promise<null> {
    return null;
  }
}

export async function createLlmAdapter(config: ToolConfig): Promise<LlmAdapter> {
  if (config.llmProvider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    const { AnthropicAdapter } = await import('./anthropic.js');
    return new AnthropicAdapter(config.llmModel);
  }
  return new NoopLlmAdapter();
}

import Anthropic from '@anthropic-ai/sdk';
import type { LlmAdapter, LlmScoreReview } from './adapter.js';
import type { GroupScores, InputUrlRow, PageContentRow, QueryGroup, ToolConfig } from '../types.js';

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    topicalRelevance: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
    intentMatch: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
    commerciality: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
    distinctTopic: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
    cannibalisationRisk: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
    rationale: { type: 'string' },
  },
  required: [
    'topicalRelevance',
    'intentMatch',
    'commerciality',
    'distinctTopic',
    'cannibalisationRisk',
    'rationale',
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a conservative SEO analyst reviewing Google Search Console query groups against a specific web page.
Score each dimension 0-5 following the client's rubric. Be conservative: do not inflate relevance, do not assume synonyms share intent, and never favour keyword stuffing or topical drift. The core question is: "Is this something someone would search when looking for this specific page?"`;

export class AnthropicAdapter implements LlmAdapter {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(private model: string) {
    this.client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }

  async reviewScores(input: {
    group: QueryGroup;
    heuristicScores: GroupScores;
    page: PageContentRow;
    inputMeta?: InputUrlRow;
    config: ToolConfig;
  }): Promise<LlmScoreReview | null> {
    const { group, heuristicScores, page, inputMeta, config } = input;
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2000,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        output_config: { format: { type: 'json_schema', schema: SCORE_SCHEMA } },
        messages: [
          {
            role: 'user',
            content: [
              `Client: ${config.clientName}`,
              config.clientContext ? `Client context: ${config.clientContext}` : '',
              config.businessPriorities ? `Business priorities: ${config.businessPriorities}` : '',
              config.targetLocations.length
                ? `Target locations: ${config.targetLocations.join(', ')}`
                : '',
              config.excludedLocations.length
                ? `Excluded locations: ${config.excludedLocations.join(', ')}`
                : '',
              '',
              `Page URL: ${page.url}`,
              `Title: ${page.titleTag}`,
              `H1: ${page.h1}`,
              `H2s: ${page.h2s.join(' | ')}`,
              `Page type: ${inputMeta?.pageType ?? 'unknown'}; target intent: ${inputMeta?.targetIntent ?? 'unknown'}; primary topic: ${inputMeta?.primaryTopic ?? 'unknown'}`,
              `Body (truncated): ${page.bodyText.slice(0, 3000)}`,
              '',
              `Query group: "${group.canonicalQuery}"`,
              `Variants: ${group.variants.map((v) => v.query).join('; ')}`,
              `Demand: ${group.totalImpressions} impressions, ${group.totalClicks} clicks, avg position ${group.weightedAvgPosition}`,
              '',
              `Heuristic scores (review and correct only if clearly wrong): ${JSON.stringify({
                topicalRelevance: heuristicScores.topicalRelevance,
                intentMatch: heuristicScores.intentMatch,
                commerciality: heuristicScores.commerciality,
                distinctTopic: heuristicScores.distinctTopic,
                cannibalisationRisk: heuristicScores.cannibalisationRisk,
              })}`,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      });

      if (response.stop_reason === 'refusal') return null;
      const text = response.content.find((b) => b.type === 'text');
      if (!text || text.type !== 'text') return null;
      return JSON.parse(text.text) as LlmScoreReview;
    } catch (err) {
      console.warn(`LLM scoring failed for "${group.canonicalQuery}": ${(err as Error).message}`);
      return null;
    }
  }
}

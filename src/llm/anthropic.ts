import Anthropic from '@anthropic-ai/sdk';
import type { LlmAdapter, LlmScoreReview } from './adapter.js';
import type {
  GroupScores,
  InputUrlRow,
  PageContentRow,
  QueryGroup,
  SuggestedEditRow,
  ToolConfig,
} from '../types.js';

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

  async draftEdit(input: {
    edit: SuggestedEditRow;
    page?: PageContentRow;
    config: ToolConfig;
  }): Promise<string | null> {
    const { edit, page, config } = input;
    if (!page || page.httpStatus !== 200) return null; // never draft copy for a page we haven't seen
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        thinking: { type: 'adaptive' },
        system:
          `You are a senior SEO copywriter drafting on-page copy for ${config.clientName || 'a client'}. ` +
          `Ground every claim strictly in the page content provided — never invent services, numbers, accreditations or claims. ` +
          `Weave keywords in naturally; no keyword stuffing, no exact-match contortions. ` +
          `Match the page's existing tone. Output ONLY the final copy in the same structural format as the template ` +
          `(keep the "H2:", "H3:", "Suggested answer:" / "Draft:" labels), with no preamble or commentary. ` +
          `FAQ answers: 2-3 direct sentences each, ending with a natural next step where appropriate.`,
        messages: [
          {
            role: 'user',
            content: [
              config.clientContext ? `Client context: ${config.clientContext}` : '',
              config.terminologyToAvoid.length
                ? `Terminology to avoid: ${config.terminologyToAvoid.join(', ')}`
                : '',
              '',
              `Page: ${edit.url}`,
              `Title: ${page.titleTag}`,
              `H1: ${page.h1}`,
              `Existing H2s: ${page.h2s.join(' | ')}`,
              `Page content: ${page.bodyText.slice(0, 6000)}`,
              '',
              `Edit type: ${edit.editType}`,
              `Placement: ${edit.whereOnPage}`,
              `Keywords this edit must cover naturally: ${edit.keywordsTargeted}`,
              '',
              `Template to rewrite into publishable draft copy:`,
              edit.suggestedCopy,
            ]
              .filter((line) => line !== '')
              .join('\n'),
          },
        ],
      });

      if (response.stop_reason === 'refusal') return null;
      const text = response.content.find((b) => b.type === 'text');
      if (!text || text.type !== 'text' || !text.text.trim()) return null;
      return text.text.trim();
    } catch (err) {
      console.warn(`LLM draft failed for ${edit.url} (${edit.editType}): ${(err as Error).message}`);
      return null;
    }
  }
}

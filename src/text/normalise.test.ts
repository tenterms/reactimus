import { describe, expect, it } from 'vitest';
import { contentSignature, contentTokens, normaliseText, singularise } from './normalise.js';

describe('normaliseText', () => {
  it('lowercases, trims, strips punctuation, collapses spaces', () => {
    expect(normaliseText('  IT Support,   Sheffield! ')).toBe('it support sheffield');
  });
  it('drops apostrophes without splitting words', () => {
    expect(normaliseText("Sheffield's IT")).toBe('sheffields it');
  });
});

describe('singularise', () => {
  it('handles regular plurals safely', () => {
    expect(singularise('services')).toBe('service');
    expect(singularise('companies')).toBe('company');
    expect(singularise('boxes')).toBe('box');
    expect(singularise('reviews')).toBe('review');
  });
  it('leaves non-plurals and exceptions alone', () => {
    expect(singularise('support')).toBe('support');
    expect(singularise('business')).toBe('business');
    expect(singularise('analysis')).toBe('analysis');
    expect(singularise('leeds')).toBe('leeds');
    expect(singularise('gas')).toBe('gas');
    expect(singularise('it')).toBe('it');
  });
});

describe('contentTokens / contentSignature', () => {
  it('drops function words', () => {
    expect(contentTokens('IT Support in Sheffield')).toEqual(['it', 'support', 'sheffield']);
  });
  it('word order does not change the signature', () => {
    expect(contentSignature('IT Support Sheffield')).toBe(contentSignature('Sheffield IT Support'));
    expect(contentSignature('IT Support in Sheffield')).toBe(
      contentSignature('IT Support Sheffield'),
    );
  });
  it('meaningful modifiers change the signature', () => {
    const base = contentSignature('IT Support Sheffield');
    expect(contentSignature('IT Services Sheffield')).not.toBe(base);
    expect(contentSignature('IT Support Services')).not.toBe(base);
    expect(contentSignature('IT Support Company')).not.toBe(base);
    expect(contentSignature('IT Support Birmingham')).not.toBe(base);
    expect(contentSignature('Technology Businesses Sheffield')).not.toBe(base);
  });
  it('does not reduce an all-function-word query to nothing', () => {
    expect(contentTokens('to the')).toEqual(['to', 'the']);
  });
});

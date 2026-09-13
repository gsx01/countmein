import { describe, expect, it } from 'vitest';
import { parseEmoji } from './api';

// The one piece of the emoji route with real branching: blank -> null coercion,
// the code-point length cap, and the "must be an emoji" guard (including flags).
describe('parseEmoji', () => {
  it('coerces null and blank to null', () => {
    expect(parseEmoji(null)).toBe(null);
    expect(parseEmoji('')).toBe(null);
    expect(parseEmoji('   ')).toBe(null);
  });

  it('trims and returns a valid emoji', () => {
    expect(parseEmoji('  \u{1F697} ')).toBe('\u{1F697}');
  });

  it('allows a regional-indicator country flag', () => {
    expect(parseEmoji('\u{1F1F3}\u{1F1F1}')).toBe('\u{1F1F3}\u{1F1F1}');
  });

  it('rejects a non-string', () => {
    expect(() => parseEmoji(5)).toThrow();
  });

  it('rejects plain text with no emoji', () => {
    expect(() => parseEmoji('car')).toThrow();
  });

  it('rejects a value longer than the code-point cap', () => {
    expect(() => parseEmoji('\u{1F697}'.repeat(13))).toThrow();
  });
});

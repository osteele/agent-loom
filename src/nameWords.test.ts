import { expect, test } from "bun:test";
import { ADJECTIVES, FRIENDLY_WORDS_REVISION, NOUNS } from "./nameWords.ts";

test("the credited friendly-word lists fit one unbiased hash byte", () => {
  expect(FRIENDLY_WORDS_REVISION).toBe(
    "f94b4639c71c26875f7684fa86a214c7f30deaad",
  );
  for (const words of [ADJECTIVES, NOUNS]) {
    expect(words).toHaveLength(256);
    expect(new Set(words)).toHaveLength(256);
    expect(words.every((word) => /^[a-z]+$/.test(word))).toBe(true);
  }
});

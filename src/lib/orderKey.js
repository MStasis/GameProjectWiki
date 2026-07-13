/**
 * Fractional order keys that can be compared with JavaScript's ordinary
 * lexicographic string comparison. Keys are intentionally URL/database safe.
 *
 * A valid key never ends with the lowest alphabet character. That canonical
 * form guarantees that another key can always be generated before it.
 */

export const ORDER_KEY_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const MAX_ORDER_KEY_LENGTH = 256;

const MIN_CHAR = ORDER_KEY_ALPHABET[0];
const MIDDLE_CHAR = ORDER_KEY_ALPHABET[Math.floor(ORDER_KEY_ALPHABET.length / 2)];
const ALPHABET_INDEX = new Map(
  Array.from(ORDER_KEY_ALPHABET, (character, index) => [character, index]),
);

export const INITIAL_ORDER_KEY = MIDDLE_CHAR;

/** Return true when `value` is a canonical fractional order key. */
export function isValidOrderKey(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ORDER_KEY_LENGTH ||
    value.endsWith(MIN_CHAR)
  ) {
    return false;
  }

  for (const character of value) {
    if (!ALPHABET_INDEX.has(character)) {
      return false;
    }
  }
  return true;
}

/**
 * Compare two valid order keys without locale-dependent collation.
 * This is useful as an Array#sort comparator.
 */
export function compareOrderKeys(left, right) {
  assertOrderKey(left, "left");
  assertOrderKey(right, "right");
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Throw a TypeError when `value` is not a canonical order key. */
export function assertOrderKey(value, name = "orderKey") {
  if (!isValidOrderKey(value)) {
    throw new TypeError(
      `${name} must be a non-empty order key using only ${ORDER_KEY_ALPHABET} ` +
        `and must not end with ${JSON.stringify(MIN_CHAR)}.`,
    );
  }
  return value;
}

function assertGeneratedLength(key) {
  if (key.length > MAX_ORDER_KEY_LENGTH) {
    throw new RangeError(
      `No order key could be generated within ${MAX_ORDER_KEY_LENGTH} characters; ` +
        "rebalance the surrounding items before inserting again.",
    );
  }
  return key;
}

function keyAfter(key) {
  return assertGeneratedLength(`${key}${MIDDLE_CHAR}`);
}

/** Generate a canonical, non-empty key lexicographically before `upper`. */
function keyBefore(upper) {
  let zeroPrefixLength = 0;
  while (upper[zeroPrefixLength] === MIN_CHAR) {
    zeroPrefixLength += 1;
  }

  // `upper` is canonical, so a non-minimum character must eventually occur.
  const upperDigit = ALPHABET_INDEX.get(upper[zeroPrefixLength]);
  const prefix = upper.slice(0, zeroPrefixLength);
  let suffix;

  if (upperDigit === 1) {
    // There is no alphabet character strictly between 0 and 1. Extending 0
    // keeps the result below 1 while remaining above the empty-string bound.
    suffix = `${MIN_CHAR}${MIDDLE_CHAR}`;
  } else {
    suffix = ORDER_KEY_ALPHABET[Math.floor(upperDigit / 2)];
  }

  return assertGeneratedLength(`${prefix}${suffix}`);
}

/**
 * Generate an order key strictly between `before` and `after`.
 *
 * Use null/undefined for an open boundary:
 *   orderKeyBetween(null, null) -> an initial key
 *   orderKeyBetween(existing, null) -> a key after `existing`
 *   orderKeyBetween(null, existing) -> a key before `existing`
 */
export function orderKeyBetween(before = null, after = null) {
  const lower = before ?? null;
  const upper = after ?? null;

  if (lower !== null) {
    assertOrderKey(lower, "before");
  }
  if (upper !== null) {
    assertOrderKey(upper, "after");
  }
  if (lower !== null && upper !== null && lower >= upper) {
    throw new RangeError("before must sort strictly before after.");
  }

  if (lower === null && upper === null) {
    return INITIAL_ORDER_KEY;
  }
  if (upper === null) {
    return keyAfter(lower);
  }
  if (lower === null) {
    return keyBefore(upper);
  }

  let commonLength = 0;
  const sharedLimit = Math.min(lower.length, upper.length);
  while (
    commonLength < sharedLimit &&
    lower[commonLength] === upper[commonLength]
  ) {
    commonLength += 1;
  }

  const commonPrefix = lower.slice(0, commonLength);

  if (commonLength === lower.length) {
    // The lower key is a prefix of the upper key. A non-empty suffix before
    // the upper remainder is necessarily after the lower key.
    return assertGeneratedLength(
      `${commonPrefix}${keyBefore(upper.slice(commonLength))}`,
    );
  }

  const lowerDigit = ALPHABET_INDEX.get(lower[commonLength]);
  const upperDigit = ALPHABET_INDEX.get(upper[commonLength]);

  if (upperDigit - lowerDigit > 1) {
    const middleDigit = Math.floor((lowerDigit + upperDigit) / 2);
    return assertGeneratedLength(
      `${commonPrefix}${ORDER_KEY_ALPHABET[middleDigit]}`,
    );
  }

  // Adjacent digits leave no room at this position. Keep the lower digit and
  // append a key after the rest of the lower key; the first differing digit
  // still guarantees that the result sorts below `upper`.
  const lowerRemainder = lower.slice(commonLength + 1);
  return assertGeneratedLength(
    `${commonPrefix}${lower[commonLength]}${keyAfter(lowerRemainder)}`,
  );
}

// Descriptive aliases keep call sites readable in both model and UI code.
export const generateOrderKey = orderKeyBetween;
export const betweenOrderKeys = orderKeyBetween;

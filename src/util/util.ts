/**
 * Checks if a string matches a pattern where the initial uppercase letters in the pattern
 * must be matched (case-insensitive), and remaining lowercase characters are optional (subsequence matching).
 * The match is case-insensitive, and uppercase letters are assumed to be at the start of the pattern.
 * Assumes non-empty strings for both inputs.
 * @param str - The string to check.
 * @param pattern - The pattern to match against, with uppercase letters at the start.
 * @returns True if the string matches the pattern, false otherwise.
 */
export function matchesPattern(str: string, pattern: string): boolean {
    // Find the number of initial uppercase letters in the pattern
    if (str.length > pattern.length) return false;

    let upperCaseCount = 0;
    const patternLen = pattern.length;
    for (; upperCaseCount < patternLen; upperCaseCount++) {
        const code = pattern.charCodeAt(upperCaseCount);
        if (code < 65 || code > 90) break; // not A-Z
    }

    // If str is too short, fail
    if (str.length < upperCaseCount) return false;

    // Compare initial uppercase letters (case-insensitive)
    for (let i = 0; i < upperCaseCount; i++) {
        if (str[i].toLowerCase() !== pattern[i].toLowerCase()) return false;
    }

    for (let i = upperCaseCount; i < str.length; i++) {
        if (str[i].toLowerCase() !== pattern[i].toLowerCase()) return false;
    }
    return true;
}
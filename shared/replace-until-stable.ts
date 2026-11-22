/** Applies a global `pattern` again until nothing changes, so a match that only forms once an earlier one is removed is removed too. */
export function replaceUntilStable(text: string, pattern: RegExp, replacement: string): string {
  let current = text;
  for (let previous = ""; previous !== current;) {
    previous = current;
    current = current.replace(pattern, replacement);
  }
  return current;
}

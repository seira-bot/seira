export interface TodoBatchField {
  /** On a bot line: the todos the bot added in this turn, in order. The line's `text` lists them for a client that does not draw the card. */
  todoBatch?: { todoIds: string[] };
}

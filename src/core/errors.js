/**
 * An error the user caused and should be told about. Anything else that
 * escapes the hub is a bug and is reported as a generic failure.
 */
export class ChatError extends Error {
  /**
   * @param {string} code machine-readable code, e.g. `nick_in_use`
   * @param {string} message sentence shown to the user
   */
  constructor(code, message) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
  }
}

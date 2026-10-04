export class HttpError extends Error {
  constructor(status, code, description) {
    super(description);
    this.status = status;
    this.code = code;
  }
}
export class ReadModelBadRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReadModelBadRequestError";
    }
}

export class ReadModelNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReadModelNotFoundError";
    }
}

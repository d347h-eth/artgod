export type TokenSetAttribute = {
    key: string;
    value: string;
};

export type TokenSetSchema =
    | {
          kind: "attribute";
          data: {
              collection: string;
              attributes: TokenSetAttribute[];
          };
      }
    | {
          kind: "collection";
          data: {
              collection: string;
          };
      };

export type TokenSetResolution = {
    tokenSetId: string;
    schemaHash: string;
    merkleRoot: string;
    tokenCount: number;
};

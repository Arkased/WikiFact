// The part of `jsdom` that the page helper (`dom.ts`) uses; the package ships no types.
declare module "jsdom" {
  export class JSDOM {
    constructor(markup?: string);
    readonly window: { readonly document: Document };
  }
}

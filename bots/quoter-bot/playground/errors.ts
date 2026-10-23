/** Signals that imported JSON does not match a supported collection shape. */
export class CollectionImportError extends Error {}

/** Signals that a collection cannot be exported because runtime validation failed. */
export class CollectionValidationError extends Error {}

/** Signals that a playground URL fragment cannot be safely encoded or decoded. */
export class FragmentCodecError extends Error {}

/** Signals that the playground cannot initialize its required browser mount point. */
export class PlaygroundInitializationError extends Error {}

/** Signals that a runtime-valid collection cannot produce its synthetic preview. */
export class PreviewGenerationError extends Error {}

/** Signals that strict bounded JSON decoding rejected user-provided text. */
export class StrictJsonError extends Error {}

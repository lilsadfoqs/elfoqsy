// Compile-time only: fails `pnpm typecheck` if a zod schema stops matching contracts/events.ts,
// or if an event type is added to events.ts without a schema.
import type { z } from 'zod';
import type { EventType, PayloadOf, payloadSchemas } from './schemas';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Schemas = typeof payloadSchemas;
type Matches = { [K in EventType]: Equal<z.infer<Schemas[K]>, PayloadOf<K>> };
/** Event types whose schema differs from events.ts; must stay `never`. */
type Mismatched = { [K in EventType]: Matches[K] extends true ? never : K }[EventType];

export type SchemasCoverEveryEvent = Expect<Equal<keyof Schemas, EventType>>;
export type SchemasMatchEvents = Expect<Equal<Mismatched, never>>;

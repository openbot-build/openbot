/**
 * Every table of the database, for the relations in `Database.ts`.
 *
 * A workaround for the build: when one module imports another module as a
 * namespace (`import * as`), tsdown with `unbundle` adds one more export, with
 * that namespace, to the imported module. Other packages read every export of
 * `Schema` and `AuthSchema` as a table, so `Database.ts` imports this inside
 * module as the namespace, and the public modules keep only their own exports.
 */
export * from "../Schema.ts"
export * from "../AuthSchema.ts"

/**
 * VersioningModule — provides the schema versioning helpers, compatibility
 * transforms, and deprecation middleware as a globally-available module.
 *
 * Import once in AppModule; no need to re-import in feature modules.
 *
 * Issue: #64
 */

import { Global, Module } from "@nestjs/common";

// Re-export the transform utilities so feature modules can import from here.
export * from "./schema-version";
export * from "./compatibility.transforms";
// Re-exported so feature modules can import the deprecation opt-in from the
// versioning entry point rather than reaching into the decorator file (#142).
export * from "./deprecated-api.decorator";

@Global()
@Module({})
export class VersioningModule {}

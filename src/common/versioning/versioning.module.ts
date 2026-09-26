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

@Global()
@Module({})
export class VersioningModule {}

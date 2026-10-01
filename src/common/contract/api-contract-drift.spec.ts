import * as fs from 'fs';
import * as path from 'path';

describe('Public API Contract Drift & Schema Invariant Tests', () => {
  const openApiPath = path.join(__dirname, '../../../docs/openapi.json');
  let openApiSpec: any;

  beforeAll(() => {
    if (!fs.existsSync(openApiPath)) {
      throw new Error(
        `OpenAPI spec not found at ${openApiPath}. Please run npm run openapi:export first.`,
      );
    }
    const rawContent = fs.readFileSync(openApiPath, 'utf-8');
    openApiSpec = JSON.parse(rawContent);
  });

  describe('OpenAPI Specification Core Invariants', () => {
    it('should have a valid openapi version and info object', () => {
      expect(openApiSpec.openapi).toMatch(/^3\./);
      expect(openApiSpec.info).toBeDefined();
      expect(openApiSpec.info.title).toContain('Trellis');
      expect(openApiSpec.info.version).toBeDefined();
    });

    it('should define required security schemes (JWT-auth, api-key)', () => {
      const securitySchemes = openApiSpec.components?.securitySchemes;
      expect(securitySchemes).toBeDefined();
      expect(securitySchemes['JWT-auth']).toBeDefined();
      expect(securitySchemes['JWT-auth'].type).toBe('http');
      expect(securitySchemes['JWT-auth'].scheme).toBe('bearer');
      expect(securitySchemes['api-key']).toBeDefined();
    });
  });

  describe('Core API Endpoints Contract Coverage', () => {
    const expectedContractRoutes = [
      { path: '/health', methods: ['get'] },
      { path: '/auth/challenge', methods: ['post'] },
      { path: '/auth/verify', methods: ['post'] },
      { path: '/notifications/send', methods: ['post'] },
      { path: '/notifications/history/{userId}', methods: ['get'] },
      { path: '/notifications/mark-read', methods: ['post'] },
      { path: '/reconcile/stellar/invoice', methods: ['post'] },
      { path: '/reconcile/stellar/transactions', methods: ['post'] },
      { path: '/oracle/payloads', methods: ['post'] },
      { path: '/import/validate', methods: ['post'] },
      { path: '/import/execute', methods: ['post'] },
      { path: '/import/portfolio-assets', methods: ['post'] },
    ];

    it('should document all critical lifecycle, auth, import, oracle, and reconciliation routes without path drift', () => {
      const paths = openApiSpec.paths || {};
      const allPaths = Object.keys(paths);

      for (const expected of expectedContractRoutes) {
        const matchedPath = allPaths.find(
          (p) =>
            p === expected.path ||
            p === `/api/v1${expected.path}` ||
            p.endsWith(expected.path),
        );

        expect(matchedPath).toBeDefined();
        if (matchedPath) {
          const pathObj = paths[matchedPath];
          for (const method of expected.methods) {
            expect(pathObj[method]).toBeDefined();
          }
        }
      }
    });
  });

  describe('Schema Contract Drift & Field Invariants', () => {
    it('should include deepLink and deduplicationKey in SendNotificationDto schema', () => {
      const schemas = openApiSpec.components?.schemas || {};
      const notifSchema = schemas['SendNotificationDto'];

      expect(notifSchema).toBeDefined();
      expect(notifSchema.properties).toBeDefined();
      expect(notifSchema.properties.deepLink).toBeDefined();
      expect(notifSchema.properties.deduplicationKey).toBeDefined();
    });

    it('should include dryRun, entityType, and rows in ImportRequestDto schema', () => {
      const schemas = openApiSpec.components?.schemas || {};
      const importSchema = schemas['ImportRequestDto'];

      expect(importSchema).toBeDefined();
      expect(importSchema.properties).toBeDefined();
      expect(importSchema.properties.entityType).toBeDefined();
      expect(importSchema.properties.dryRun).toBeDefined();
      expect(importSchema.properties.rows).toBeDefined();
    });

    it('should include rollbackGuidance, preview, errors, and counts in ImportResultDto schema', () => {
      const schemas = openApiSpec.components?.schemas || {};
      const resultSchema = schemas['ImportResultDto'];

      expect(resultSchema).toBeDefined();
      expect(resultSchema.properties).toBeDefined();
      expect(resultSchema.properties.totalRows).toBeDefined();
      expect(resultSchema.properties.createCount).toBeDefined();
      expect(resultSchema.properties.updateCount).toBeDefined();
      expect(resultSchema.properties.skipCount).toBeDefined();
      expect(resultSchema.properties.errorCount).toBeDefined();
      expect(resultSchema.properties.preview).toBeDefined();
      expect(resultSchema.properties.errors).toBeDefined();
      expect(resultSchema.properties.rollbackGuidance).toBeDefined();
    });

    it('should declare standard HTTP responses for endpoints', () => {
      const paths = openApiSpec.paths || {};
      let verifiedRoutes = 0;

      for (const [, pathObj] of Object.entries<any>(paths)) {
        for (const [method, operation] of Object.entries<any>(pathObj)) {
          if (
            ['get', 'post', 'put', 'delete'].includes(method) &&
            operation.responses
          ) {
            const hasAnyResponse = Object.keys(operation.responses).length > 0;
            expect(hasAnyResponse).toBe(true);
            verifiedRoutes++;
          }
        }
      }

      expect(verifiedRoutes).toBeGreaterThan(15);
    });
  });

  describe('Payload & Parameter Validation Contracts', () => {
    it('should have consistent parameter and query schemas across endpoints', () => {
      const paths = openApiSpec.paths || {};
      for (const [, pathObj] of Object.entries<any>(paths)) {
        for (const [method, operation] of Object.entries<any>(pathObj)) {
          if (
            ['get', 'post', 'put', 'delete'].includes(method) &&
            operation.parameters
          ) {
            for (const param of operation.parameters) {
              expect(param.name).toBeDefined();
              expect(param.in).toMatch(/^(query|header|path|cookie)$/);
            }
          }
        }
      }
    });
  });
});

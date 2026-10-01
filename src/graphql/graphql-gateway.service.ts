import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import {
  execute,
  ExecutionResult,
  NoSchemaIntrospectionCustomRule,
  parse,
  specifiedRules,
  validate,
  buildSchema,
} from "graphql";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { AgentReviewsService } from "src/discovery/reviews/agent-reviews.service";
import { AgentReview } from "src/discovery/reviews/entities/agent-review.entity";
import { UserService } from "src/core/user/user.service";
import { AgentReviewAuthorLoader } from "./loaders/agent-review-author.loader";

import { createDepthLimitRule } from "./rules/depth-limit.rule";
import { createQueryComplexityRule } from "./rules/query-complexity.rule";

export interface GraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

const schemaPaths = [
  join(__dirname, "schema.graphql"),
  join(process.cwd(), "src/graphql/schema.graphql"),
  join(process.cwd(), "dist/graphql/schema.graphql"),
];

function findSchemaPath(): string {
  const schemaPath = schemaPaths.find((candidate) => existsSync(candidate));
  if (!schemaPath) {
    throw new Error(
      `GraphQL schema not found. Checked: ${schemaPaths.join(", ")}`,
    );
  }
  return schemaPath;
}

@Injectable()
export class GraphqlGatewayService {
  private readonly schema = buildSchema(readFileSync(findSchemaPath(), "utf8"));
  private readonly maxDepth: number;
  private readonly maxComplexity: number;

  constructor(
    private readonly reviewsService: AgentReviewsService,
    private readonly userService: UserService,
    @Optional() options?: { maxDepth?: number; maxComplexity?: number },
  ) {
    this.maxDepth = options?.maxDepth ?? 6;
    this.maxComplexity = options?.maxComplexity ?? 100;
  }

  /** Execute one GraphQL operation with a fresh relationship loader cache. */
  async execute(request: GraphqlRequest): Promise<ExecutionResult> {
    if (
      !request ||
      typeof request.query !== "string" ||
      !request.query.trim()
    ) {
      throw new BadRequestException("A GraphQL query string is required");
    }
    if (
      request.variables !== undefined &&
      (request.variables === null ||
        typeof request.variables !== "object" ||
        Array.isArray(request.variables))
    ) {
      throw new BadRequestException("GraphQL variables must be an object");
    }

    let document;
    try {
      document = parse(request.query);
    } catch (error) {
      return { errors: [error] } as ExecutionResult;
    }

    const validationRules = [
      ...specifiedRules,
      ...(process.env.NODE_ENV === "production"
        ? [NoSchemaIntrospectionCustomRule]
        : []),
      createDepthLimitRule(this.maxDepth),
      createQueryComplexityRule(this.maxComplexity),
    ];
    const validationErrors = validate(this.schema, document, validationRules);
    if (validationErrors.length > 0) return { errors: validationErrors };

    const authorLoader = new AgentReviewAuthorLoader(this.userService);
    const rootValue = {
      agentReviews: async ({ agentId, first, after }) => {
        const connection =
          await this.reviewsService.getApprovedReviewsConnection(
            agentId,
            first,
            after ?? undefined,
          );
        return {
          ...connection,
          edges: connection.edges.map((edge) => ({
            ...edge,
            node: this.toGraphqlReview(edge.node, authorLoader),
          })),
        };
      },
      agentRating: async ({ agentId }) => {
        const aggregation = await this.reviewsService.getAggregation(agentId);
        return {
          ...aggregation,
          ratingDistribution: [1, 2, 3, 4, 5].map((rating) => ({
            rating,
            count: aggregation.ratingDistribution[rating] ?? 0,
          })),
        };
      },
    };

    return execute({
      schema: this.schema,
      document,
      rootValue,
      variableValues: request.variables,
      operationName: request.operationName,
    });
  }

  private toGraphqlReview(
    review: AgentReview,
    authorLoader: AgentReviewAuthorLoader,
  ) {
    return {
      ...review,
      createdAt: review.createdAt.toISOString(),
      updatedAt: review.updatedAt.toISOString(),
      developerRespondedAt: review.developerRespondedAt?.toISOString() ?? null,
      author: () => authorLoader.load(review.userId),
    };
  }
}

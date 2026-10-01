import {
  ASTNode,
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  GraphQLError,
  InlineFragmentNode,
  Kind,
  OperationDefinitionNode,
  SelectionSetNode,
  ValidationContext,
  ValidationRule,
} from "graphql";

export interface DepthLimitOptions {
  ignore?: (string | RegExp)[];
}

/**
 * Creates a GraphQL validation rule that restricts the maximum query depth.
 * Default maxDepth is 6.
 */
export function createDepthLimitRule(
  maxDepth: number = 6,
  options: DepthLimitOptions = {},
): ValidationRule {
  const ignorePatterns = options.ignore ?? [/^__/];

  return function depthLimitRule(context: ValidationContext) {
    const fragments: Record<string, FragmentDefinitionNode> = {};

    return {
      OperationDefinition(node: OperationDefinitionNode) {
        // Collect fragments from document first
        const doc = context.getDocument();
        for (const def of doc.definitions) {
          if (def.kind === Kind.FRAGMENT_DEFINITION) {
            fragments[def.name.value] = def;
          }
        }

        const depth = calculateDepth(
          node.selectionSet,
          0,
          fragments,
          new Set<string>(),
          ignorePatterns,
        );

        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query exceeds maximum depth of ${maxDepth} (actual depth: ${depth})`,
              { nodes: [node] },
            ),
          );
        }
      },
    };
  };
}

function calculateDepth(
  selectionSet: SelectionSetNode | undefined,
  currentDepth: number,
  fragments: Record<string, FragmentDefinitionNode>,
  seenFragments: Set<string>,
  ignorePatterns: (string | RegExp)[],
): number {
  if (
    !selectionSet ||
    !selectionSet.selections ||
    selectionSet.selections.length === 0
  ) {
    return currentDepth;
  }

  let maxChildDepth = currentDepth;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fieldNode = selection as FieldNode;
      const fieldName = fieldNode.name.value;

      const isIgnored = ignorePatterns.some((pattern) =>
        typeof pattern === "string"
          ? pattern === fieldName
          : pattern.test(fieldName),
      );

      if (isIgnored) continue;

      if (fieldNode.selectionSet) {
        const d = calculateDepth(
          fieldNode.selectionSet,
          currentDepth + 1,
          fragments,
          seenFragments,
          ignorePatterns,
        );
        if (d > maxChildDepth) maxChildDepth = d;
      } else {
        if (currentDepth + 1 > maxChildDepth) {
          maxChildDepth = currentDepth + 1;
        }
      }
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const spreadNode = selection as FragmentSpreadNode;
      const fragmentName = spreadNode.name.value;

      if (!seenFragments.has(fragmentName) && fragments[fragmentName]) {
        seenFragments.add(fragmentName);
        const d = calculateDepth(
          fragments[fragmentName].selectionSet,
          currentDepth,
          fragments,
          seenFragments,
          ignorePatterns,
        );
        seenFragments.delete(fragmentName);
        if (d > maxChildDepth) maxChildDepth = d;
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const inlineNode = selection as InlineFragmentNode;
      const d = calculateDepth(
        inlineNode.selectionSet,
        currentDepth,
        fragments,
        seenFragments,
        ignorePatterns,
      );
      if (d > maxChildDepth) maxChildDepth = d;
    }
  }

  return maxChildDepth;
}

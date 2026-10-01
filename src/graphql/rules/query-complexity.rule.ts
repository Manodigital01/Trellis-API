import {
  ArgumentNode,
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
  ValueNode,
} from "graphql";

export interface ComplexityOptions {
  scalarCost?: number;
  objectCost?: number;
  fieldCosts?: Record<string, number>;
}

/**
 * Creates a GraphQL validation rule that restricts maximum query complexity.
 * Prevents high-cost, high-cardinality queries from executing resolvers.
 */
export function createQueryComplexityRule(
  maxComplexity: number = 100,
  options: ComplexityOptions = {},
): ValidationRule {
  const scalarCost = options.scalarCost ?? 1;
  const objectCost = options.objectCost ?? 2;
  const fieldCosts = options.fieldCosts ?? {};

  return function queryComplexityRule(context: ValidationContext) {
    const fragments: Record<string, FragmentDefinitionNode> = {};

    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const doc = context.getDocument();
        for (const def of doc.definitions) {
          if (def.kind === Kind.FRAGMENT_DEFINITION) {
            fragments[def.name.value] = def;
          }
        }

        const complexity = calculateSelectionSetComplexity(
          node.selectionSet,
          1,
          fragments,
          new Set<string>(),
          scalarCost,
          objectCost,
          fieldCosts,
        );

        if (complexity > maxComplexity) {
          context.reportError(
            new GraphQLError(
              `Query complexity of ${complexity} exceeds maximum allowed complexity of ${maxComplexity}`,
              { nodes: [node] },
            ),
          );
        }
      },
    };
  };
}

function getArgumentMultiplier(args?: readonly ArgumentNode[]): number {
  if (!args || args.length === 0) return 1;

  for (const arg of args) {
    const name = arg.name.value.toLowerCase();
    if (["first", "limit", "count", "take", "pagesize"].includes(name)) {
      const val = extractNumericValue(arg.value);
      if (val !== null && val > 0) {
        return val;
      }
    }
  }

  return 1;
}

function extractNumericValue(valueNode: ValueNode): number | null {
  if (valueNode.kind === Kind.INT) {
    return parseInt(valueNode.value, 10);
  }
  if (valueNode.kind === Kind.FLOAT) {
    return parseFloat(valueNode.value);
  }
  return null;
}

function calculateSelectionSetComplexity(
  selectionSet: SelectionSetNode | undefined,
  currentMultiplier: number,
  fragments: Record<string, FragmentDefinitionNode>,
  seenFragments: Set<string>,
  scalarCost: number,
  objectCost: number,
  fieldCosts: Record<string, number>,
): number {
  if (!selectionSet || !selectionSet.selections) return 0;

  let total = 0;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fieldNode = selection as FieldNode;
      const fieldName = fieldNode.name.value;

      // Ignore introspection
      if (fieldName.startsWith("__")) continue;

      const baseCost =
        fieldCosts[fieldName] ??
        (fieldNode.selectionSet ? objectCost : scalarCost);
      total += baseCost * currentMultiplier;

      if (fieldNode.selectionSet) {
        const multiplier = getArgumentMultiplier(fieldNode.arguments);
        const childMultiplier = currentMultiplier * multiplier;
        total += calculateSelectionSetComplexity(
          fieldNode.selectionSet,
          childMultiplier,
          fragments,
          seenFragments,
          scalarCost,
          objectCost,
          fieldCosts,
        );
      }
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const spreadNode = selection as FragmentSpreadNode;
      const fragmentName = spreadNode.name.value;

      if (!seenFragments.has(fragmentName) && fragments[fragmentName]) {
        seenFragments.add(fragmentName);
        total += calculateSelectionSetComplexity(
          fragments[fragmentName].selectionSet,
          currentMultiplier,
          fragments,
          seenFragments,
          scalarCost,
          objectCost,
          fieldCosts,
        );
        seenFragments.delete(fragmentName);
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const inlineNode = selection as InlineFragmentNode;
      total += calculateSelectionSetComplexity(
        inlineNode.selectionSet,
        currentMultiplier,
        fragments,
        seenFragments,
        scalarCost,
        objectCost,
        fieldCosts,
      );
    }
  }

  return total;
}

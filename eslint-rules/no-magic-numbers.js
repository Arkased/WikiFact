// docs/code-standard.md, section 5: a number is named once, in a `const`, with a comment on its unit, and used by name.
// The built-in rules cannot say this: `const DAY_MS = 24 * 60 * 60 * 1000` is the place where the numbers are named, but
// `no-magic-numbers` flags 24, 60 and 1000 there.
//
// A numeric literal is allowed when it is 0, 1 or -1, or when it sits in:
// - the initializer of a `const` (at any depth, but not inside a function body nested in it);
// - an enum member;
// - a type (a numeric literal type);
// - an array index (`x[2]`).
// A default value of a parameter is not allowed.

const ALLOWED_VALUES = new Set([0, 1, -1]);
const FUNCTION_TYPES = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);

/**
 * Tells whether a node is inside the initializer of a `const`, without a function between them.
 *
 * @param {import("estree").Node} node - the node to place
 * @returns {boolean} true when the nearest enclosing declarator of a `const` holds the node in its initializer
 */
function inConstInitializer(node) {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (FUNCTION_TYPES.has(parent.type)) return false;
    if (parent.type === "VariableDeclarator") {
      return parent.init === child && parent.parent?.kind === "const";
    }
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      magic:
        "Magic number {{value}}: name it once in a `const` with a comment on the unit (docs/code-standard.md, section 5).",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== "number") return;
        // `-1` is a unary minus on the literal 1.
        const negated = node.parent?.type === "UnaryExpression" && node.parent.operator === "-";
        const value = negated ? -node.value : node.value;
        if (ALLOWED_VALUES.has(value)) return;
        const top = negated ? node.parent : node;
        const parent = top.parent;
        if (parent?.type === "TSLiteralType" || parent?.type === "TSEnumMember") return;
        if (parent?.type === "MemberExpression" && parent.computed && parent.property === top) return;
        if (inConstInitializer(top)) return;
        context.report({ node: top, messageId: "magic", data: { value: String(value) } });
      },
    };
  },
};

export default rule;

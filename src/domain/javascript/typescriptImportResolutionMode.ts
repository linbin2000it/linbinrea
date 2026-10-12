import type { ImportDeclaration } from "@babel/types";

/** An explicit type-import attribute overrides the source file's loader default. */
export const typescriptImportResolutionMode = (
  node: ImportDeclaration,
): "import" | "require" | undefined => {
  if (node.importKind !== "type") return undefined;
  const attribute = node.attributes?.find(
    ({ key }) =>
      (key.type === "StringLiteral" ? key.value : key.name) ===
      "resolution-mode",
  );
  const mode = attribute?.value.value;
  return mode === "import" || mode === "require" ? mode : undefined;
};

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ICON_NAMES } from "../fixtures/icons.mjs";

function typescriptFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function setIconLiterals(file) {
  const sourceText = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "setIcon" &&
      node.arguments.length >= 2 &&
      ts.isStringLiteralLike(node.arguments[1])
    ) {
      names.push(node.arguments[1].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return names;
}

export function auditIconNames(srcDir) {
  const literals = new Set();
  for (const file of typescriptFiles(srcDir)) {
    for (const name of setIconLiterals(file)) {
      literals.add(name);
    }
  }

  const registered = new Set(Object.values(ICON_NAMES));
  const names = [...literals].sort();
  return {
    names,
    missing: names.filter((name) => !registered.has(name)),
  };
}

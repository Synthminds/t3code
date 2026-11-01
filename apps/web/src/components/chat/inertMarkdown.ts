import type { Root, RootContent } from "mdast";

// Untrusted Markdown must not load URLs or turn authored links into app actions.
export function inertMarkdown() {
  function clean(nodes: RootContent[]): RootContent[] {
    return nodes.flatMap((node): RootContent[] => {
      if (node.type === "html" || node.type === "definition") return [];
      if (node.type === "image" || node.type === "imageReference")
        return [{ type: "text", value: node.alt ?? "" }];
      if (node.type === "link" || node.type === "linkReference") return clean(node.children);
      if (node.type === "inlineCode") return [{ type: "text", value: node.value }];
      if (node.type === "code" && node.lang === "mermaid") return [{ ...node, lang: "text" }];
      if ("children" in node) node.children = clean(node.children) as typeof node.children;
      return [node];
    });
  }
  return (tree: Root) => {
    tree.children = clean(tree.children) as Root["children"];
  };
}

import { AdfNode } from "./types";

// adf-to-md has no TypeScript types - declare the module manually
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adf2md = (require("adf-to-md") as { convert: (adf: unknown) => { result: string; warnings: string[] } }).convert;

/**
 * Convert an Atlassian Document Format (ADF) node to a Markdown string.
 * Uses adf-to-md as the base converter with a custom preprocessing step
 * for node types the library doesn't handle (mentions, panels, status, media, etc.).
 */
export function convertAdfToMarkdown(adf: AdfNode | null | undefined): string {
  if (!adf) return "";

  try {
    let doc = adf;

    // Wrap bare content nodes in a doc root if needed
    if (doc.type !== "doc") {
      doc = { type: "doc", version: 1, content: [doc] };
    }

    // Pre-process unsupported nodes before passing to the library
    const preprocessed = preprocessAdf(doc);
    const { result, warnings } = adf2md(preprocessed);

    if (warnings && warnings.length > 0 && process.env.VERBOSE) {
      console.warn("ADF conversion warnings:", warnings);
    }

    return result.trim();
  } catch {
    // Final fallback: extract plain text by walking text nodes
    return extractPlainText(adf).trim();
  }
}

/**
 * Pre-process ADF to handle nodes that adf-to-md discards or mishandles:
 * - mention   → @displayName text
 * - status    → **[LABEL]** bold text
 * - date      → ISO date string
 * - panel     → blockquote
 * - expand    → heading + content
 * - mediaSingle / mediaGroup → [attachment] placeholder
 * - inlineCard / blockCard → URL link
 */
function preprocessAdf(node: AdfNode): AdfNode {
  if (!node.content) return node;

  const processedContent = node.content.map((child): AdfNode => {
    switch (child.type) {
      case "mention": {
        const name =
          (child.attrs?.text as string) ??
          (child.attrs?.id as string) ??
          "unknown";
        return { type: "text", text: `@${name}` };
      }

      case "status": {
        const label = (child.attrs?.text as string) ?? "STATUS";
        return { type: "text", text: `**[${label}]**` };
      }

      case "date": {
        const ts = child.attrs?.timestamp as number | undefined;
        const dateStr = ts
          ? new Date(ts).toISOString().split("T")[0]
          : "unknown date";
        return { type: "text", text: dateStr };
      }

      case "panel": {
        const innerContent = child.content
          ? child.content.map(preprocessAdf)
          : [];
        return { type: "blockquote", content: innerContent };
      }

      case "expand":
      case "nestedExpand": {
        const title = (child.attrs?.title as string) ?? "";
        const nodes: AdfNode[] = [];
        if (title) {
          nodes.push({
            type: "paragraph",
            content: [{ type: "text", text: `**${title}**` }],
          });
        }
        nodes.push(...(child.content?.map(preprocessAdf) ?? []));
        return { type: "doc", content: nodes };
      }

      case "mediaSingle":
      case "mediaGroup": {
        const mediaNode = child.content?.[0];
        const altText = (mediaNode?.attrs?.alt as string) ?? "attachment";
        return {
          type: "paragraph",
          content: [{ type: "text", text: `[${altText}]` }],
        };
      }

      case "taskList": {
        const items = (child.content ?? []).map((item): AdfNode => {
          const checked = item.attrs?.state === "DONE";
          const text = extractPlainText(item);
          return {
            type: "paragraph",
            content: [{ type: "text", text: `- [${checked ? "x" : " "}] ${text}` }],
          };
        });
        return { type: "doc", content: items };
      }

      case "inlineCard":
      case "blockCard": {
        const url = (child.attrs?.url as string) ?? "";
        return { type: "text", text: url };
      }

      case "table": {
        // Render table rows as markdown table
        const rows = child.content ?? [];
        const markdownRows: string[] = [];
        rows.forEach((row, rowIndex) => {
          const cells = row.content ?? [];
          const cellTexts = cells.map((cell) => {
            const cellContent = cell.content ? cell.content.map(preprocessAdf) : [];
            return cellContent
              .map(extractPlainText)
              .join(" ")
              .replace(/\|/g, "\\|")
              .trim();
          });
          markdownRows.push(`| ${cellTexts.join(" | ")} |`);
          // Add separator after header row
          if (rowIndex === 0) {
            markdownRows.push(`| ${cellTexts.map(() => "---").join(" | ")} |`);
          }
        });
        return {
          type: "paragraph",
          content: [{ type: "text", text: markdownRows.join("\n") }],
        };
      }

      default:
        return preprocessAdf(child);
    }
  });

  return { ...node, content: processedContent };
}

/** Recursively extract all text content from an ADF node as plain text */
function extractPlainText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  if (!node.content) return "";
  return node.content.map(extractPlainText).join(" ");
}
